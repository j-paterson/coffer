import { describe, expect, test } from "bun:test";
import { createTestCtx } from "./setup";
import {
  FixtureError,
  loadScenarioText,
  loadScenario,
} from "./scenarios";

describe("scenario loader", () => {
  test("loads a minimal scenario", () => {
    const { db } = createTestCtx();
    loadScenarioText(db, `
name: minimal
description: just one account
as_of: 2026-04-27
accounts:
  - { id: a, type: checking, institution: Test, display_name: A, mode: live, active: 1 }
`, "(inline)");
    const rows = db.query("SELECT id, type FROM accounts WHERE type = 'checking'").all() as Array<{ id: string; type: string }>;
    expect(rows).toEqual([{ id: "a", type: "checking" }]);
  });

  test("unknown column throws FixtureError", () => {
    const { db } = createTestCtx();
    expect(() => loadScenarioText(db, `
name: bad
description: x
as_of: 2026-04-27
accounts:
  - { id: a, type: checking, institution: Test, display_name: A, not_a_column: oops }
`, "(inline)")).toThrow(/unknown column.*not_a_column.*accounts/i);
  });

  test("missing required column throws FixtureError", () => {
    const { db } = createTestCtx();
    expect(() => loadScenarioText(db, `
name: bad
description: x
as_of: 2026-04-27
accounts:
  - { id: a, type: checking, display_name: A }
`, "(inline)")).toThrow(/required column.*institution/i);
  });

  test("balanced postings load and validate", () => {
    const { db } = createTestCtx();
    loadScenarioText(db, `
name: bal
description: balanced txn
as_of: 2026-04-27
accounts:
  - { id: a, type: checking, institution: Test, display_name: A }
  - { id: b, type: checking, institution: Test, display_name: B }
postings:
  - txn:
      date: 2025-06-01
      description: transfer
      derived_by: ingest
    legs:
      - { account_id: a, amount: 100.00 }
      - { account_id: b, amount: -100.00 }
`, "(inline)");
    const n = (db.query("SELECT COUNT(*) c FROM postings").get() as { c: number }).c;
    expect(n).toBe(2);
  });

  test("validate=false skips invariants", () => {
    const { db } = createTestCtx();
    loadScenarioText(db, `
name: unbal
description: x
as_of: 2026-04-27
accounts:
  - { id: a, type: checking, institution: Test, display_name: A }
  - { id: b, type: checking, institution: Test, display_name: B }
postings:
  - txn: { date: 2025-06-01, description: bad, derived_by: ingest }
    legs:
      - { account_id: a, amount: 100.00 }
      - { account_id: b, amount: -50.00 }
`, "(inline)", { validate: false });
    const n = (db.query("SELECT COUNT(*) c FROM postings").get() as { c: number }).c;
    expect(n).toBe(2);
  });

  test("validate=true runs invariants and throws", () => {
    const { db } = createTestCtx();
    expect(() => loadScenarioText(db, `
name: unbal
description: x
as_of: 2026-04-27
accounts:
  - { id: a, type: checking, institution: Test, display_name: A }
  - { id: b, type: checking, institution: Test, display_name: B }
postings:
  - txn: { date: 2025-06-01, description: bad, derived_by: ingest }
    legs:
      - { account_id: a, amount: 100.00 }
      - { account_id: b, amount: -50.00 }
`, "(inline)")).toThrow(/INV-1/);
  });

  test("loads simple_household.yaml from disk", () => {
    const { db } = createTestCtx();
    const doc = loadScenario(db, "simple_household");
    expect(doc.name).toBe("simple_household");
    const n = (db.query("SELECT COUNT(*) c FROM accounts").get() as { c: number }).c;
    expect(n).toBeGreaterThan(0);
  });
});
