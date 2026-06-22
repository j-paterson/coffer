/** diagnose networth <YYYY-MM-DD>
 *
 * Tree drill-down of net worth on one date.
 * For each account: value (walkV2-style), and if skip_pad, per-position
 * source attribution (winner + losers) and duplicate detection. */

import { db, latestSnapshotAtOrBefore, fmtUSD, fmtQty, padR } from "./lib";

export function run(args: string[]): number {
  const date = args[0];
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error("usage: diagnose networth <YYYY-MM-DD>");
    return 1;
  }

  const accounts = db.prepare(
    `SELECT id, display_name, display_name_override, type, skip_pad, active,
            merged_into
     FROM accounts
     WHERE active = 1 AND merged_into IS NULL`
  ).all() as Array<{
    id: string; display_name: string; display_name_override: string | null;
    type: string; skip_pad: number; active: number; merged_into: string | null;
  }>;

  type Row = {
    id: string; name: string; type: string; skip_pad: boolean;
    value: number; detail: string;
  };
  const rows: Row[] = [];
  let total = 0;

  for (const a of accounts) {
    const name = a.display_name_override ?? a.display_name;
    const detail = a.skip_pad
      ? skipPadDetail(a.id, date)
      : postingsDetail(a.id, date);
    const value = detail.value;
    total += value;
    rows.push({
      id: a.id, name, type: a.type, skip_pad: !!a.skip_pad,
      value, detail: detail.text,
    });
  }

  rows.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  console.log(`\nNET WORTH on ${date}: ${fmtUSD(total)}\n`);
  console.log(`  (walkV2-style: skip_pad accounts use highest-trust snapshot per position,`);
  console.log(`   others use postings cumulative + anchor assertions)\n`);

  console.log(`${padR("value", 14)}  ${"type".padEnd(10)}  account`);
  console.log("─".repeat(90));
  for (const r of rows) {
    if (Math.abs(r.value) < 1) continue;
    const flag = r.skip_pad ? "S" : " ";
    console.log(`${padR(fmtUSD(r.value), 14)}  ${r.type.padEnd(10)}  ${flag} ${r.name}  [${r.id}]`);
    if (r.detail) console.log(r.detail);
  }
  console.log("\n(S = skip_pad account)\n");
  return 0;
}

function skipPadDetail(acctId: string, date: string): { value: number; text: string } {
  // Pull aliases merging into this canonical.
  const aliases = db.prepare(
    "SELECT id FROM accounts WHERE id = ? OR merged_into = ?"
  ).all(acctId, acctId) as Array<{ id: string }>;
  const allIds = aliases.map(a => a.id);
  const ph = allIds.map(() => "?").join(",");

  const positions = db.prepare(
    `SELECT p.id, p.symbol, p.chain, p.contract_address, p.account_id
     FROM positions p WHERE p.account_id IN (${ph})`
  ).all(...allIds) as Array<{ id: number; symbol: string; chain: string; contract_address: string; account_id: string }>;

  if (positions.length === 0) return { value: 0, text: "" };

  type PosLine = {
    position_id: number; symbol: string; chain: string; contract: string;
    winner: string | null; winner_rank: number; winner_date: string | null;
    winner_val: number; winner_qty: number | null;
    dropped_dup: boolean;
  };
  const lines: PosLine[] = [];
  for (const p of positions) {
    const w = latestSnapshotAtOrBefore(p.id, date);
    lines.push({
      position_id: p.id,
      symbol: p.symbol,
      chain: p.chain,
      contract: p.contract_address,
      winner: w?.source ?? null,
      winner_rank: w?.rank ?? -1,
      winner_date: w?.as_of ?? null,
      winner_val: w?.value_usd ?? 0,
      winner_qty: w?.quantity ?? null,
      dropped_dup: false,
    });
  }

  // Mirror walkV2 dedupe: per (chain, symbol) drop contract='' siblings
  // when a contract-populated row exists.
  const byKey = new Map<string, PosLine[]>();
  for (const l of lines) {
    const k = `${l.chain}|${l.symbol}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(l);
  }
  for (const siblings of byKey.values()) {
    if (siblings.length < 2) continue;
    const hasContract = siblings.some(s => s.contract !== "");
    if (!hasContract) continue;
    for (const s of siblings) if (s.contract === "") s.dropped_dup = true;
  }

  const kept = lines.filter(l => !l.dropped_dup && l.winner && l.winner_val !== 0);
  const total = kept.reduce((a, l) => a + l.winner_val, 0);

  kept.sort((a, b) => Math.abs(b.winner_val) - Math.abs(a.winner_val));
  const dropped = lines.filter(l => l.dropped_dup);

  let text = "";
  for (const l of kept) {
    const staleness = l.winner_date === date ? "" : ` (stale: ${l.winner_date})`;
    text += `               └─ ${padR(fmtUSD(l.winner_val), 12)} ${l.symbol.padEnd(10)} qty=${fmtQty(l.winner_qty).padEnd(14)} src=${l.winner}${staleness}\n`;
  }
  if (dropped.length) {
    text += `               (dropped ${dropped.length} duplicate contract-empty rows: ${dropped.map(d => d.symbol).join(", ")})\n`;
  }
  return { value: total, text: text.replace(/\n$/, "") };
}

function postingsDetail(acctId: string, date: string): { value: number; text: string } {
  // Postings cumulative + latest enabled anchor on-or-before date.
  const aliases = db.prepare(
    "SELECT id FROM accounts WHERE id = ? OR merged_into = ?"
  ).all(acctId, acctId) as Array<{ id: string }>;
  const allIds = aliases.map(a => a.id);
  const ph = allIds.map(() => "?").join(",");

  // Enabled assertion sources.
  const enabled = (db.prepare("SELECT name FROM data_sources WHERE kind='assertion' AND enabled=1").all() as Array<{ name: string }>).map(r => r.name);
  const assPh = enabled.map(() => "?").join(",");

  // Anchor at-or-before date, highest rank.
  let anchor: { as_of: string; expected_usd: number; source: string } | null = null;
  if (enabled.length) {
    anchor = db.prepare(
      `SELECT ba.as_of, ba.expected_usd, ba.source
       FROM balance_assertions ba
       JOIN data_sources ds ON ds.name = ba.source AND ds.kind = 'assertion'
       WHERE ba.account_id IN (${ph})
         AND ba.as_of <= ?
         AND ba.source IN (${assPh})
         AND ds.enabled = 1
       ORDER BY ba.as_of DESC, ds.trust_rank ASC
       LIMIT 1`
    ).get(...allIds, date, ...enabled) as { as_of: string; expected_usd: number; source: string } | null;
  }

  const anchorDate = anchor?.as_of ?? "0000-00-00";

  // Sum postings from anchor+1 (or beginning) through date.
  const deltas = db.prepare(
    `SELECT COALESCE(SUM(p.amount), 0) AS total
     FROM postings p JOIN transactions_v2 t ON t.id = p.txn_id
     WHERE p.account_id IN (${ph}) AND t.date > ? AND t.date <= ?`
  ).get(...allIds, anchorDate, date) as { total: number };

  const baseline = anchor?.expected_usd ?? 0;
  const postingsTotal = deltas.total ?? 0;
  const value = baseline + postingsTotal;

  let text = "";
  if (anchor) {
    text += `               ├─ anchor ${anchor.as_of} ${fmtUSD(anchor.expected_usd)} (src=${anchor.source})\n`;
  }
  if (postingsTotal !== 0) {
    text += `               └─ +${fmtUSD(postingsTotal)} postings since ${anchor ? anchor.as_of : "start"} → ${date}\n`;
  }
  return { value, text: text.replace(/\n$/, "") };
}

if (import.meta.main) process.exit(run(process.argv.slice(2)));
