/** Regression test for the real-estate-vanishing bug.
 *
 *  Symptom (pre-fix): on the breakdown chart, real-estate disappears
 *  after the last delta/anchor date in the working set. Specifically,
 *  walkV2.globalEnd is computed as max(deltas, anchors) and only
 *  clamped DOWN to today; if no signal exists between the last anchor
 *  and today, the postings-cumulative path stops emitting.
 *
 *  Fix (Phase 7): globalEnd defaults to ctx.today when windowEnd is
 *  not provided, mirroring the MTM path's cutoff.
 *
 *  Spec: docs/superpowers/specs/2026-04-27-test-system-design.md */

import { describe, expect, test } from "bun:test";
import { createTestCtx } from "../setup";
import { loadScenario } from "../scenarios";
import { walkSeveralCanonicals } from "@coffer/ledger/walker";

describe("real_estate_with_manual_anchor scenario", () => {
  test("real-estate forward-fills through ctx.today (RE-only walk)", () => {
    const ctx = createTestCtx("2026-04-27");
    loadScenario(ctx.db, "real_estate_with_manual_anchor");
    const series = walkSeveralCanonicals(
      ctx,
      ["manual:property:los-ranchos-8401"],
    ).get("manual:property:los-ranchos-8401")!;
    expect(series.get("2026-01-01")).toBe(578365);
    expect(series.get("2026-04-17")).toBe(578365);
    expect(series.get("2026-04-27")).toBe(578365);
  });

  test("real-estate forward-fills through ctx.today (full walk, no windowEnd)", () => {
    const ctx = createTestCtx("2026-04-27");
    loadScenario(ctx.db, "real_estate_with_manual_anchor");
    const canons = (ctx.db.query(
      `SELECT DISTINCT COALESCE(merged_into, id) AS canonical
       FROM accounts WHERE id NOT LIKE 'equity:%' AND active = 1`,
    ).all() as Array<{ canonical: string }>).map((r) => r.canonical);
    const all = walkSeveralCanonicals(ctx, canons);
    const re = all.get("manual:property:los-ranchos-8401")!;
    expect(re.get("2026-04-17")).toBe(578365);
    expect(re.get("2026-04-27")).toBe(578365);
  });
});
