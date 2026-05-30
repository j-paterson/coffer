/** diagnose composition [--date YYYY-MM-DD]
 *
 * Per-wallet breakdown at a date:
 *   Zerion wallet total (zerion-chart assertion)
 * - Alchemy direct holdings sum (alchemy-history snapshots)
 * = Residual → positive means DeFi/LP value Alchemy can't see.
 *             Negative means Alchemy sees more than Zerion — flagged
 *             because Zerion may have filtered some holdings as spam
 *             and we'd prefer Alchemy in that case.
 *
 * Also aggregates frequency of negative-residual wallet-dates across
 * the full history.
 */

import { db, fmtUSD, padR } from "./lib";

export function run(args: string[]): number {
  let date: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date") date = args[++i];
  }

  if (date) {
    reportSingleDate(date);
  } else {
    reportAggregate();
  }
  return 0;
}

function zerionTotalOnOrBefore(accountId: string, date: string): { val: number; anchorDate: string } | null {
  const row = db.prepare(
    `SELECT as_of, expected_usd FROM balance_assertions
     WHERE account_id = ? AND source = 'zerion-chart' AND as_of <= ?
     ORDER BY as_of DESC LIMIT 1`
  ).get(accountId, date) as { as_of: string; expected_usd: number } | undefined;
  if (!row) return null;
  return { val: row.expected_usd, anchorDate: row.as_of };
}

function alchemySumOnDate(accountId: string, date: string): { total: number; positions: Array<{ symbol: string; contract: string; val: number }> } {
  const rows = db.prepare(
    `SELECT p.symbol, p.contract_address, ps.value_usd
     FROM position_snapshots ps JOIN positions p ON p.id = ps.position_id
     WHERE p.account_id = ? AND ps.source = 'alchemy-history'
       AND ps.as_of = (
         SELECT MAX(as_of) FROM position_snapshots
         WHERE position_id = p.id AND source = 'alchemy-history' AND as_of <= ?
       )`
  ).all(accountId, date) as Array<{ symbol: string; contract_address: string; value_usd: number }>;
  let total = 0;
  const positions: Array<{ symbol: string; contract: string; val: number }> = [];
  for (const r of rows) {
    if (!(r.value_usd > 0)) continue;
    total += r.value_usd;
    positions.push({ symbol: r.symbol, contract: r.contract_address, val: r.value_usd });
  }
  positions.sort((a, b) => b.val - a.val);
  return { total, positions };
}

function reportSingleDate(date: string) {
  const wallets = db.prepare(
    `SELECT id, COALESCE(display_name_override, display_name) AS name
     FROM accounts WHERE id LIKE 'zerion:%' AND active = 1 ORDER BY id`
  ).all() as Array<{ id: string; name: string }>;

  console.log(`\n=== Composition on ${date} ===\n`);
  console.log(
    `${padR("Zerion total", 14)}  ${padR("Alchemy sum", 14)}  ${padR("Residual", 14)}  Wallet`
  );
  console.log("─".repeat(95));

  let totalZ = 0, totalA = 0, totalR = 0, negCount = 0;
  for (const w of wallets) {
    const z = zerionTotalOnOrBefore(w.id, date);
    const a = alchemySumOnDate(w.id, date);
    if (!z && a.total === 0) continue;
    const zVal = z?.val ?? 0;
    const resid = zVal - a.total;
    const flag = resid < -50 ? " ⚠" : "";
    totalZ += zVal; totalA += a.total; totalR += resid;
    if (resid < -50) negCount++;
    const shortId = w.id.replace(/^zerion:/, "").slice(0, 45);
    console.log(
      `${padR(fmtUSD(zVal), 14)}  ${padR(fmtUSD(a.total), 14)}  ${padR(fmtUSD(resid) + flag, 15)} ${shortId}`,
    );
  }
  console.log("─".repeat(95));
  console.log(
    `${padR(fmtUSD(totalZ), 14)}  ${padR(fmtUSD(totalA), 14)}  ${padR(fmtUSD(totalR), 14)}  TOTAL   (${negCount} wallet${negCount === 1 ? "" : "s"} with negative residual)`
  );
  console.log();
  if (negCount > 0) {
    console.log(`  ⚠ = Alchemy exceeds Zerion total (≥$50 delta). Zerion may be`);
    console.log(`    filtering tokens as spam; fall back to Alchemy for those wallets.\n`);
  }
}

function reportAggregate() {
  // For each wallet, for each zerion-chart anchor date, compute residual.
  // Count how many wallet-date pairs have negative residual below -$50.
  const anchors = db.prepare(
    `SELECT account_id, as_of, expected_usd
     FROM balance_assertions WHERE source = 'zerion-chart'
     ORDER BY account_id, as_of`
  ).all() as Array<{ account_id: string; as_of: string; expected_usd: number }>;

  console.log(`\n=== Residual aggregate (over ${anchors.length} wallet-date anchors) ===\n`);
  type Agg = { wallet: string; total: number; neg: number; max_neg: number; max_neg_date: string };
  const byWallet = new Map<string, Agg>();
  let grandTotal = 0, grandNeg = 0;
  let worstNeg = 0, worstNegWallet = "", worstNegDate = "";

  for (const a of anchors) {
    const alch = alchemySumOnDate(a.account_id, a.as_of);
    const resid = a.expected_usd - alch.total;
    grandTotal++;
    const agg = byWallet.get(a.account_id) ?? { wallet: a.account_id, total: 0, neg: 0, max_neg: 0, max_neg_date: "" };
    agg.total++;
    if (resid < -50) {
      agg.neg++;
      grandNeg++;
      if (resid < agg.max_neg) { agg.max_neg = resid; agg.max_neg_date = a.as_of; }
      if (resid < worstNeg) { worstNeg = resid; worstNegWallet = a.account_id; worstNegDate = a.as_of; }
    }
    byWallet.set(a.account_id, agg);
  }

  console.log(`  ${grandNeg} of ${grandTotal} wallet-date anchors have Alchemy > Zerion by >$50`);
  console.log(`  (${(grandNeg / grandTotal * 100).toFixed(1)}% of anchors flagged)\n`);

  console.log(`per-wallet neg-residual frequency:`);
  const walletList = [...byWallet.values()].sort((a, b) => (b.neg / b.total) - (a.neg / a.total));
  for (const w of walletList) {
    if (w.neg === 0) continue;
    const pct = (w.neg / w.total * 100).toFixed(0);
    const short = w.wallet.replace(/^zerion:/, "").slice(0, 55);
    console.log(`  ${padR(String(w.neg) + "/" + w.total, 8)} ${pct.padStart(3)}%  ${short}  max_neg=${fmtUSD(w.max_neg)} @ ${w.max_neg_date}`);
  }

  if (worstNeg < 0) {
    console.log(`\n  worst single case: ${fmtUSD(worstNeg)} on ${worstNegDate} — ${worstNegWallet}`);
  }
  console.log();
}

if (import.meta.main) process.exit(run(process.argv.slice(2)));
