#!/usr/bin/env bun
/**
 * Capture README screenshots from the simple_household fixture.
 *
 * Run: bun run screenshots
 * Output: docs/screenshots/{networth,spending,investments}.png
 *
 * What this script does:
 *   1. Create a temp SQLite database
 *   2. Apply migrations and seed with db/fixtures/simple_household.yaml
 *   3. Spawn @coffer/server pointing at the temp DB (FINANCE_DB env var)
 *   4. Spawn @coffer/web (default Vite dev server, proxies /api to :3001)
 *   5. Drive headless Chromium to load three pages with Privacy mode ON
 *      (pre-seeds localStorage key "finance.privacyMode" = "on")
 *   6. Save PNGs to docs/screenshots/
 *   7. Clean up server, web, and temp DB
 *
 * Requirements:
 *   - Nothing else listening on :3001 (server) or :5173 (web)
 *   - Playwright Chromium binary available (run: bunx playwright install chromium)
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";

import { applyMigrations } from "../apps/server/src/db";
import { loadScenario } from "../apps/server/test/scenarios";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SCREENSHOTS_DIR = resolve(REPO_ROOT, "docs/screenshots");
const SERVER_PORT = 3001;
const WEB_PORT = 5173;
const SERVER_HEALTH = `http://localhost:${SERVER_PORT}/api/health`;
const WEB_BASE = `http://localhost:${WEB_PORT}`;

// Privacy localStorage key and value (from apps/web/src/lib/privacy.tsx)
const PRIVACY_LS_KEY = "finance.privacyMode";
const PRIVACY_LS_VALUE = "on";

async function waitFor(url: string, label: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok || (label === "web" && r.status < 500)) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} not ready at ${url} after ${timeoutMs}ms`);
}

async function preflightPortFree(port: number, label: string): Promise<void> {
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) });
    // If the fetch succeeded, something is listening
    console.error(
      `\n[screenshots] Port ${port} (${label}) is already in use. ` +
      `Stop the existing process (or your dev server) and re-run.\n`,
    );
    process.exit(1);
  } catch {
    // Port appears free — continue
  }
}

async function capture(
  page: Page,
  path: string,
  filename: string,
): Promise<void> {
  console.log(`  Navigating to ${WEB_BASE}${path} ...`);
  // Use "load" instead of "networkidle" — Vite's HMR WebSocket keeps
  // a persistent connection that prevents networkidle from ever firing.
  await page.goto(`${WEB_BASE}${path}`, { waitUntil: "load", timeout: 45_000 });
  // Wait for the nav sidebar to appear, indicating React has rendered
  await page.waitForSelector("aside nav", { timeout: 15_000 });
  // Additional settle for data fetches and animations
  await page.waitForTimeout(1500);
  const out = resolve(SCREENSHOTS_DIR, filename);
  await page.screenshot({ path: out, fullPage: false });
  console.log(`    Wrote ${out}`);
}

async function main(): Promise<void> {
  await preflightPortFree(SERVER_PORT, "server");
  await preflightPortFree(WEB_PORT, "web");

  // Ensure output directory exists
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  // 1. Temp DB + seed
  const workdir = mkdtempSync(resolve(tmpdir(), "coffer-screenshots-"));
  const dbPath = resolve(workdir, "screenshots.sqlite");
  console.log(`[screenshots] Seeding temp DB at ${dbPath}`);
  {
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db);
    loadScenario(db, "simple_household", { validate: false });
    db.close();
  }

  // 2. Spawn server with FINANCE_DB pointing at temp DB
  console.log("[screenshots] Booting @coffer/server...");
  const server = Bun.spawn(
    ["bun", "run", "src/index.ts"],
    {
      env: {
        ...process.env,
        FINANCE_DB: dbPath,
        PORT: String(SERVER_PORT),
      },
      cwd: resolve(REPO_ROOT, "apps/server"),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // 3. Spawn web (Vite proxies /api to localhost:3001 already)
  console.log("[screenshots] Booting @coffer/web...");
  const web = Bun.spawn(
    ["bun", "run", "dev"],
    {
      env: {
        ...process.env,
        // Vite may need this to not open a browser window
        BROWSER: "none",
      },
      cwd: resolve(REPO_ROOT, "apps/web"),
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  let browser: Browser | undefined;
  let exitCode = 0;
  try {
    // 4. Wait for both to be ready
    console.log("[screenshots] Waiting for server...");
    await waitFor(SERVER_HEALTH, "server");
    console.log("[screenshots] Server ready. Waiting for web...");
    await waitFor(WEB_BASE, "web");
    console.log("[screenshots] Web ready.");

    // 5. Launch Chromium with privacy mode pre-seeded in localStorage
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });

    // Inject privacy-on before the app loads so it's active at first paint.
    // privacy.tsx reads localStorage.getItem("finance.privacyMode") === "on"
    await ctx.addInitScript((args) => {
      try {
        localStorage.setItem(args.key, args.value);
      } catch {
        // ignore (e.g. in sandboxed iframes)
      }
    }, { key: PRIVACY_LS_KEY, value: PRIVACY_LS_VALUE });

    const page = await ctx.newPage();

    console.log("[screenshots] Capturing pages...");
    await capture(page, "/", "networth.png");

    // Spending: navigate, then widen range to 90 days so May transactions show.
    console.log(`  Navigating to ${WEB_BASE}/spending ...`);
    await page.goto(`${WEB_BASE}/spending`, { waitUntil: "load", timeout: 45_000 });
    await page.waitForSelector("aside nav", { timeout: 15_000 });
    await page.waitForTimeout(800);
    // Click the "90 days" range button
    const btn90 = page.getByRole("button", { name: "90 days" });
    if (await btn90.isVisible()) {
      await btn90.click();
      await page.waitForTimeout(800);
    }
    {
      const out = resolve(SCREENSHOTS_DIR, "spending.png");
      await page.screenshot({ path: out, fullPage: false });
      console.log(`    Wrote ${out}`);
    }

    await capture(page, "/investments", "investments.png");

    console.log("[screenshots] Done.");
  } catch (err) {
    console.error("[screenshots] failed:", err);
    exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill();
    web.kill();
    rmSync(workdir, { recursive: true, force: true });
    console.log("[screenshots] Cleaned up temp DB and processes.");
  }
  process.exit(exitCode);
}

main();
