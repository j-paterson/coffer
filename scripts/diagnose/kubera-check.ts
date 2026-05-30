/** diagnose kubera-check
 *
 * Gut-check: at each kubera-recap assertion date, compare Kubera's
 * aggregate net worth to what our walkV2 series would produce on the
 * same date. Highlights where we're materially off.
 *
 * Note: kubera-recap is ingested as balance_assertions — one row per
 * account per quarter. The "total" is SUM(expected_usd) across those
 * accounts. That's Kubera's own number for that moment in time.
 */

import { db, fmtUSD, padR } from "./lib";

export async function run(args: string[]): Promise<number> {
  const anchors = db.prepare(`
    SELECT as_of, ROUND(SUM(expected_usd), 0) kubera_total
    FROM balance_assertions
    WHERE source = 'kubera-recap'
    GROUP BY as_of ORDER BY as_of
  `).all() as Array<{ as_of: string; kubera_total: number }>;

  if (anchors.length === 0) { console.log("No kubera-recap assertions in DB."); return 0; }

  console.log(`\n=== Kubera vs walkV2 gut check ===\n`);
  console.log(`Reads live API at http://localhost:3001 for walkV2 values.\n`);
  console.log(`${padR("date", 12)}  ${padR("kubera", 14)}  ${padR("walkV2", 14)}  ${padR("Δ abs", 14)}  Δ%`);
  console.log("─".repeat(72));

  // Pull series for the full kubera range once.
  const start = anchors[0].as_of;
  const end = anchors[anchors.length - 1].as_of;

  try {
    const r = await fetch(`http://localhost:3001/api/v2/networth/series?start=${start}&end=${end}&granularity=day`);
    const series = await r.json() as Array<{ date: string; net_worth: number }>;
    const byDate = new Map(series.map(s => [s.date, s.net_worth]));
    for (const a of anchors) {
      const walked = byDate.get(a.as_of) ?? null;
      if (walked === null) {
        console.log(`${a.as_of}  ${padR(fmtUSD(a.kubera_total), 14)}  ${padR("no walk", 14)}  —             —`);
        continue;
      }
      const delta = walked - a.kubera_total;
      const pct = a.kubera_total !== 0 ? (delta / a.kubera_total) * 100 : 0;
      const sign = delta >= 0 ? "+" : "";
      console.log(
        `${a.as_of}  ${padR(fmtUSD(a.kubera_total), 14)}  ${padR(fmtUSD(walked), 14)}  ${padR(sign + fmtUSD(delta), 14)}  ${sign}${pct.toFixed(0)}%`
      );
    }
    console.log();
    console.log("  (negative Δ = walkV2 missing value vs Kubera — investigate coverage gaps)");
    console.log("  (positive Δ = walkV2 has stale pad postings or double-counted data)");
    console.log();
    return 0;
  } catch (e) {
    console.error(`API fetch failed — is dashboard dev server running? ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
