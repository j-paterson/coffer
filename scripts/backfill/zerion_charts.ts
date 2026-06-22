#!/usr/bin/env bun
/** Zerion historical wallet-total chart backfill.
 *
 * For each active `zerion:<chain>:<addr>` account, fetch the /charts/max
 * endpoint — returns one wallet-total USD value per day, covering the
 * full life of the wallet. Zerion's total includes DeFi / LP positions,
 * which our alchemy-history walker cannot see.
 *
 * Writes:
 *   - raw_events (source='zerion-chart') — the full JSON response per
 *     wallet per fetch, so we never need to hit Zerion again to replay.
 *   - balance_assertions (source='zerion-chart') — one row per (wallet,
 *     date). Non-destructive ON CONFLICT upsert.
 *
 * Rate limit: Zerion demo is 1 req/s; we throttle at 2s between calls.
 */

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const DB_PATH = resolve(REPO, "db/finance.sqlite");

function loadApiKey(): string {
  const env = readFileSync(resolve(REPO, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^ZERION_API_KEY=(.+)$/);
    if (m) return m[1].trim();
  }
  throw new Error("ZERION_API_KEY not in .env");
}

const authHeader = (key: string) =>
  "Basic " + Buffer.from(key + ":").toString("base64");

type ZerionChartResponse = {
  data?: {
    attributes?: {
      points?: [number, number][];
    };
  };
};

async function fetchChart(
  addr: string,
  chain: string,
  auth: string,
): Promise<ZerionChartResponse> {
  const url =
    `https://api.zerion.io/v1/wallets/${addr}/charts/max` +
    `?currency=usd&filter%5Bchain_ids%5D=${chain}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, {
      headers: {
        Authorization: auth,
        Accept: "application/json",
        "User-Agent": "finance-pipeline/1.0 (+local)",
      },
    });
    if (r.ok) return await r.json();
    if (r.status === 429 && attempt < 3) {
      await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
      continue;
    }
    throw new Error(`zerion chart ${chain} ${addr.slice(0, 10)}: HTTP ${r.status}`);
  }
}

async function main() {
  const db = new Database(DB_PATH);
  const auth = authHeader(loadApiKey());
  const today = new Date().toISOString().slice(0, 10);

  const wallets = db.prepare(
    `SELECT id FROM accounts WHERE active = 1 AND id LIKE 'zerion:%'
     ORDER BY id`,
  ).all() as Array<{ id: string }>;

  console.log(`Zerion chart backfill — ${wallets.length} wallets`);

  const upsertAssert = db.prepare(
    `INSERT INTO balance_assertions (account_id, as_of, expected_usd, source)
     VALUES (?, ?, ?, 'zerion-chart')
     ON CONFLICT(account_id, as_of, source) DO UPDATE SET
       expected_usd = excluded.expected_usd`,
  );
  const insertRaw = db.prepare(
    `INSERT OR IGNORE INTO raw_events (source, external_id, payload)
     VALUES ('zerion-chart', ?, ?)`,
  );

  let totalPoints = 0;
  let lastCall = 0;
  for (const w of wallets) {
    const parts = w.id.split(":");
    if (parts.length !== 3) continue;
    const [, chain, addr] = parts;

    // Throttle: 2s between calls (demo tier is 1/s; leave headroom).
    const elapsed = Date.now() - lastCall;
    if (elapsed < 2000) await new Promise(r => setTimeout(r, 2000 - elapsed));
    lastCall = Date.now();

    let payload: ZerionChartResponse;
    try {
      payload = await fetchChart(addr, chain, auth);
    } catch (e) {
      console.log(`  ${w.id.slice(0, 55)}  ERR ${(e as Error).message}`);
      continue;
    }

    // Cache raw response first.
    insertRaw.run(
      `zerion-chart:${chain}:${addr.toLowerCase()}:${today}`,
      JSON.stringify(payload),
    );

    const points = payload?.data?.attributes?.points ?? [];
    if (!Array.isArray(points) || points.length === 0) {
      console.log(`  ${w.id.slice(0, 55)}  no points`);
      continue;
    }

    db.exec("BEGIN");
    let written = 0;
    for (const p of points as [number, number][]) {
      const ts = p[0];
      const value = p[1];
      if (value == null) continue;
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      upsertAssert.run(w.id, date, value);
      written++;
    }
    db.exec("COMMIT");
    totalPoints += written;
    console.log(
      `  ${w.id.slice(0, 55)}  +${written} points (${new Date(points[0][0] * 1000).toISOString().slice(0, 10)} → ${new Date(points[points.length - 1][0] * 1000).toISOString().slice(0, 10)})`,
    );
  }

  console.log(`\nDone. ${totalPoints} balance_assertion rows written.`);
  db.close();
}

main();
