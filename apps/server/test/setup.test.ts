import { describe, expect, test } from "bun:test";
import { createTestCtx } from "./setup";

describe("createTestCtx", () => {
  test("opens a fresh in-memory DB with migrations applied", () => {
    const ctx = createTestCtx();
    const tables = ctx.db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("accounts");
    expect(names).toContain("postings");
    expect(names).toContain("transactions_v2");
    expect(names).toContain("balance_assertions");
    expect(names).toContain("position_snapshots");
    expect(names).toContain("data_sources");
  });

  test("today defaults to 2026-04-27", () => {
    const ctx = createTestCtx();
    expect(ctx.today).toBe("2026-04-27");
  });

  test("today can be overridden", () => {
    const ctx = createTestCtx("2025-12-31");
    expect(ctx.today).toBe("2025-12-31");
  });

  test("each call returns a fresh DB", () => {
    const a = createTestCtx();
    const b = createTestCtx();
    const baseCount = (b.db.query("SELECT COUNT(*) c FROM accounts").get() as { c: number }).c;
    a.db.exec("INSERT INTO accounts (id, display_name, institution, type, currency, active, mode) VALUES ('x', 'X', 'I', 'checking', 'USD', 1, 'live')");
    const inA = a.db.query("SELECT COUNT(*) c FROM accounts").get() as { c: number };
    const inB = b.db.query("SELECT COUNT(*) c FROM accounts").get() as { c: number };
    expect(inA.c).toBe(baseCount + 1);
    expect(inB.c).toBe(baseCount);
  });
});
