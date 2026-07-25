import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at packages/config/src/env.ts, so the monorepo root is three
// levels up. Resolved from the module URL (not process.cwd()) so it points at
// the repo regardless of which workspace launched the process.
const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

/**
 * Load the monorepo-root `.env` into `process.env`.
 *
 * Bun auto-loads `.env` only from the process's current working directory.
 * When `bun run --filter '@coffer/server' dev` (and likewise for `@coffer/web`)
 * launches a workspace, that cwd is the *package* directory — so the repo-root
 * `.env`, where a live dog-fooding instance sets `FINANCE_DB` / `PORT` /
 * `WEB_PORT`, is never seen. The symptom is nasty: the server silently falls
 * back to the in-tree default DB path and creates a fresh empty database.
 *
 * This loads the repo-root `.env` explicitly so `bun run dev` behaves the same
 * no matter which workspace it fans out to.
 *
 * Semantics: the real process environment always wins — a key already present
 * in `process.env` (e.g. exported in the shell) is never overwritten. Missing
 * file is a no-op. Idempotent and cheap; safe to call more than once.
 *
 * @param root  Override the directory to read `.env` from (defaults to repo root).
 */
export function loadRootEnv(root: string = REPO_ROOT): void {
  const path = resolve(root, ".env");
  if (!existsSync(path)) return;

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // Unreadable (permissions, race) — treat as absent rather than crash boot.
    return;
  }

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    // Skip malformed keys and never clobber an already-set variable (shell wins).
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    let value = line.slice(eq + 1).trim();
    // Strip a single layer of matching surrounding quotes.
    if (
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") &&
      value[value.length - 1] === value[0]
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
