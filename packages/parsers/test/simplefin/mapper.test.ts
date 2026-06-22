import { describe, expect, test } from "bun:test";
import { mapSimpleFinResponses } from "../../src/simplefin/mapper";
import type { SimpleFinAccountsResponse } from "../../src/simplefin/client";

describe("mapSimpleFinResponses — single-window happy path", () => {
  test("emits no ops for empty responses array", () => {
    const ops = mapSimpleFinResponses({ responses: [], asOf: "2026-05-01", overrides: {} });
    expect(ops).toEqual([]);
  });

  test("emits account_discovery + balance raw_event + assertion + sorted txn pairs", () => {
    const r: SimpleFinAccountsResponse = {
      accounts: [
        {
          id: "acct-1",
          name: "Joint Checking",
          currency: "USD",
          balance: "1234.56",
          org: { name: "Northwind Bank", domain: "northwindbank.com" },
          transactions: [
            { id: "t-2", posted: 1700000200, amount: "-25.00", description: "Coffee" },
            { id: "t-1", posted: 1700000100, amount: "1000.00", description: "Paycheck" },
          ],
        },
      ],
      errlist: [],
    };
    const ops = mapSimpleFinResponses({ responses: [r], asOf: "2026-05-01", overrides: {} });

    // 1 account_discovery + 1 balance raw_event + 1 assertion + 2 (raw_event + one_sided) txn pairs = 7
    expect(ops).toHaveLength(7);

    expect(ops[0]).toEqual({
      kind: "account_discovery",
      draft: {
        id: "simplefin:acct-1",
        display_name: "Joint Checking",
        institution: "Northwind Bank",
        type: "checking",
        currency: "USD",
        mode: "live",
        external_id: "acct-1",
        source: "simplefin",
      },
    });

    expect(ops[1]).toEqual({
      kind: "raw_event",
      source: "simplefin",
      external_id: "simplefin:acct-1:balance:2026-05-01",
      payload: { account_id: "acct-1", balance: "1234.56", currency: "USD", as_of: "2026-05-01" },
    });

    expect(ops[2]).toEqual({
      kind: "assertion",
      draft: {
        account_id: "simplefin:acct-1",
        as_of: "2026-05-01",
        expected_usd: 1234.56,
        source: "simplefin",
      },
      event_refs: [{ source: "simplefin", external_id: "simplefin:acct-1:balance:2026-05-01" }],
    });

    // Transactions sorted ascending by posted, so t-1 comes first.
    expect(ops[3]).toEqual({
      kind: "raw_event",
      source: "simplefin",
      external_id: "simplefin:acct-1:t-1",
      payload: {
        account_id: "acct-1",
        id: "t-1",
        posted: 1700000100,
        amount: "1000.00",
        description: "Paycheck",
        pending: false,
      },
    });

    expect(ops[4]).toEqual({
      kind: "one_sided",
      draft: {
        date: "2023-11-14",  // 1700000100 → 2023-11-14 in UTC
        description: "Paycheck",
        account_id: "simplefin:acct-1",
        amount: 1000.0,
        currency: "USD",
        derived_by: "simplefin",
      },
      event_refs: [{ source: "simplefin", external_id: "simplefin:acct-1:t-1" }],
    });

    expect(ops[5]!.kind).toBe("raw_event");
    expect((ops[5] as { external_id: string }).external_id).toBe("simplefin:acct-1:t-2");
    expect(ops[6]!.kind).toBe("one_sided");
  });

  test("sorts accounts by id ascending", () => {
    const r: SimpleFinAccountsResponse = {
      accounts: [
        { id: "z-acct", name: "Z", currency: "USD", balance: "0.00", transactions: [] },
        { id: "a-acct", name: "A", currency: "USD", balance: "0.00", transactions: [] },
      ],
      errlist: [],
    };
    const ops = mapSimpleFinResponses({ responses: [r], asOf: "2026-05-01", overrides: {} });
    const discoveries = ops.filter((o) => o.kind === "account_discovery");
    expect((discoveries[0]!.draft as { id: string }).id).toBe("simplefin:a-acct");
    expect((discoveries[1]!.draft as { id: string }).id).toBe("simplefin:z-acct");
  });

  test("falls back to org.domain then 'Unknown' when org.name is missing", () => {
    const r: SimpleFinAccountsResponse = {
      accounts: [
        { id: "a", name: "A", currency: "USD", balance: "0.00", org: { domain: "x.com" }, transactions: [] },
        { id: "b", name: "B", currency: "USD", balance: "0.00", transactions: [] },
      ],
      errlist: [],
    };
    const ops = mapSimpleFinResponses({ responses: [r], asOf: "2026-05-01", overrides: {} });
    const discoveries = ops.filter((o) => o.kind === "account_discovery");
    expect((discoveries[0]!.draft as { institution: string }).institution).toBe("x.com");
    expect((discoveries[1]!.draft as { institution: string }).institution).toBe("Unknown");
  });
});

describe("mapSimpleFinResponses — holdings", () => {
  test("emits raw_event + position_snapshot per holding, sorted by symbol", () => {
    const r: SimpleFinAccountsResponse = {
      accounts: [
        {
          id: "brk-1", name: "Brokerage", currency: "USD", balance: "5000.00",
          transactions: [],
          holdings: [
            { symbol: "VTI", shares: "10", market_value: "2000.00", cost_basis: "1500.00" },
            { symbol: "BND", shares: "20", market_value: "1500.00", cost_basis: "1400.00" },
          ],
        },
      ],
      errlist: [],
    };
    const ops = mapSimpleFinResponses({ responses: [r], asOf: "2026-05-01", overrides: {} });

    expect(ops).toHaveLength(7);

    const positions = ops.filter((o) => o.kind === "position_snapshot");
    expect(positions).toHaveLength(2);
    expect((positions[0]!.draft as { symbol: string }).symbol).toBe("BND");
    expect((positions[1]!.draft as { symbol: string }).symbol).toBe("VTI");

    const vti = positions[1]!.draft as {
      account_id: string; symbol: string; chain: string | null; contract_address: string | null;
      as_of: string; qty: number; price_usd: number | null; source: string;
    };
    expect(vti).toEqual({
      account_id: "simplefin:brk-1",
      symbol: "VTI",
      chain: null,
      contract_address: null,
      as_of: "2026-05-01",
      qty: 10,
      price_usd: 200,
      source: "simplefin",
    });

    const vtiRaw = ops.find(
      (o) => o.kind === "raw_event" && (o as { external_id: string }).external_id === "simplefin:brk-1:hold:VTI:2026-05-01",
    );
    expect(vtiRaw).toBeDefined();
    expect((vtiRaw as { payload: { cost_basis?: string } }).payload.cost_basis).toBe("1500.00");
  });

  test("price_usd is null when shares is 0 or missing", () => {
    const r: SimpleFinAccountsResponse = {
      accounts: [
        {
          id: "brk-1", name: "B", currency: "USD", balance: "0", transactions: [],
          holdings: [{ symbol: "ZERO", shares: "0", market_value: "100.00" }],
        },
      ],
      errlist: [],
    };
    const ops = mapSimpleFinResponses({ responses: [r], asOf: "2026-05-01", overrides: {} });
    const pos = ops.find((o) => o.kind === "position_snapshot");
    expect((pos!.draft as { price_usd: number | null }).price_usd).toBeNull();
  });
});

describe("mapSimpleFinResponses — errlist", () => {
  test("emits one sync_warning per errlist entry, after all account ops", () => {
    const r: SimpleFinAccountsResponse = {
      accounts: [
        { id: "a", name: "A", currency: "USD", balance: "1.00", transactions: [] },
      ],
      errlist: ["bank login failed for X", "rate limited by Y"],
    };
    const ops = mapSimpleFinResponses({ responses: [r], asOf: "2026-05-01", overrides: {} });

    const warnings = ops.filter((o) => o.kind === "sync_warning");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toEqual({
      kind: "sync_warning",
      warning: { source: "simplefin", scope: "errlist", message: "bank login failed for X" },
    });
    expect(warnings[1]).toEqual({
      kind: "sync_warning",
      warning: { source: "simplefin", scope: "errlist", message: "rate limited by Y" },
    });

    const lastAccountOpIdx = ops.findIndex((o) => o.kind === "sync_warning") - 1;
    expect(ops[lastAccountOpIdx]!.kind).toBe("assertion");
  });
});

describe("mapSimpleFinResponses — skip and error cases", () => {
  test("account missing id → sync_warning + skip; siblings still emitted", () => {
    const r: SimpleFinAccountsResponse = {
      accounts: [
        { name: "Bad", currency: "USD", balance: "0", transactions: [] } as unknown as { id: string; name: string; currency: string; balance: string; transactions: never[] },
        { id: "good", name: "Good", currency: "USD", balance: "0", transactions: [] },
      ],
      errlist: [],
    };
    const ops = mapSimpleFinResponses({ responses: [r], asOf: "2026-05-01", overrides: {} });

    const warnings = ops.filter((o) => o.kind === "sync_warning");
    expect(warnings).toHaveLength(1);
    expect((warnings[0]!.warning.message).toLowerCase()).toContain("missing id");

    const discoveries = ops.filter((o) => o.kind === "account_discovery");
    expect(discoveries).toHaveLength(1);
    expect((discoveries[0]!.draft as { id: string }).id).toBe("simplefin:good");
  });

  test("txn missing both posted and transacted_at → sync_warning + skip", () => {
    const r: SimpleFinAccountsResponse = {
      accounts: [
        {
          id: "a", name: "A", currency: "USD", balance: "0",
          transactions: [
            { id: "good", posted: 1700000000, amount: "1.00", description: "ok" },
            { id: "bad", amount: "2.00", description: "no date" },
          ],
        },
      ],
      errlist: [],
    };
    const ops = mapSimpleFinResponses({ responses: [r], asOf: "2026-05-01", overrides: {} });

    const warnings = ops.filter((o) => o.kind === "sync_warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.warning.scope).toBe("a");
    expect(warnings[0]!.warning.message.toLowerCase()).toContain("no posted date");

    const oneSided = ops.filter((o) => o.kind === "one_sided");
    expect(oneSided).toHaveLength(1);
    expect((oneSided[0]!.draft as { description: string | null }).description).toBe("ok");
  });

  test("txn with non-numeric amount → sync_warning + skip", () => {
    const r: SimpleFinAccountsResponse = {
      accounts: [
        {
          id: "a", name: "A", currency: "USD", balance: "0",
          transactions: [
            { id: "bad", posted: 1700000000, amount: "not-a-number", description: "weird" },
          ],
        },
      ],
      errlist: [],
    };
    const ops = mapSimpleFinResponses({ responses: [r], asOf: "2026-05-01", overrides: {} });

    const warnings = ops.filter((o) => o.kind === "sync_warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.warning.message.toLowerCase()).toContain("amount");

    const oneSided = ops.filter((o) => o.kind === "one_sided");
    expect(oneSided).toHaveLength(0);
  });

  test("holding missing both symbol and description → UNKNOWN + sync_warning, still emitted", () => {
    const r: SimpleFinAccountsResponse = {
      accounts: [
        {
          id: "brk", name: "B", currency: "USD", balance: "0",
          transactions: [],
          holdings: [{ shares: "5", market_value: "100.00" }],
        },
      ],
      errlist: [],
    };
    const ops = mapSimpleFinResponses({ responses: [r], asOf: "2026-05-01", overrides: {} });

    const warnings = ops.filter((o) => o.kind === "sync_warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.warning.scope).toBe("brk");
    expect(warnings[0]!.warning.message.toLowerCase()).toContain("symbol");

    const positions = ops.filter((o) => o.kind === "position_snapshot");
    expect(positions).toHaveLength(1);
    expect((positions[0]!.draft as { symbol: string }).symbol).toBe("UNKNOWN");
  });

  test("holding falls back to description prefix when symbol is missing but description is present (no warning)", () => {
    const r: SimpleFinAccountsResponse = {
      accounts: [
        {
          id: "brk", name: "B", currency: "USD", balance: "0",
          transactions: [],
          holdings: [{ description: "Vanguard Total Stock Market", shares: "5", market_value: "100.00" }],
        },
      ],
      errlist: [],
    };
    const ops = mapSimpleFinResponses({ responses: [r], asOf: "2026-05-01", overrides: {} });

    expect(ops.filter((o) => o.kind === "sync_warning")).toHaveLength(0);
    const positions = ops.filter((o) => o.kind === "position_snapshot");
    expect((positions[0]!.draft as { symbol: string }).symbol).toBe("Vanguard Total Stock Market");
  });
});

describe("mapSimpleFinResponses — account-type inference + overrides", () => {
  function discover(name: string, balance: string, overrides = {}): { type: string; display_name: string; institution: string } {
    const r: SimpleFinAccountsResponse = {
      accounts: [{ id: "a", name, currency: "USD", balance, org: { name: "Bank" }, transactions: [] }],
      errlist: [],
    };
    const ops = mapSimpleFinResponses({ responses: [r], asOf: "2026-05-01", overrides });
    const discovery = ops.find((o) => o.kind === "account_discovery");
    return (discovery as { kind: "account_discovery"; draft: { type: string; display_name: string; institution: string } })!.draft;
  }

  test("balance < 0 → 'credit'", () => {
    expect(discover("Some Card", "-50.00").type).toBe("credit");
  });

  test("name contains 'saving' → 'savings'", () => {
    expect(discover("HYSA Savings", "100.00").type).toBe("savings");
  });

  test("name contains '401' / 'ira' / 'retire' → 'retirement'", () => {
    expect(discover("My 401k", "100.00").type).toBe("retirement");
    expect(discover("Roth IRA", "100.00").type).toBe("retirement");
    expect(discover("Retirement Acct", "100.00").type).toBe("retirement");
  });

  test("name contains 'invest' / 'brokerage' → 'brokerage'", () => {
    expect(discover("Brokerage", "100.00").type).toBe("brokerage");
    expect(discover("Investment Account", "100.00").type).toBe("brokerage");
  });

  test("default → 'checking'", () => {
    expect(discover("Joint Account", "100.00").type).toBe("checking");
  });

  test("type override wins over heuristic", () => {
    expect(discover("Some Card", "-50.00", { a: { type: "loan" } }).type).toBe("loan");
  });

  test("display_name override wins over acct.name", () => {
    expect(discover("Acme XYZ12345", "100.00", { a: { display_name: "Cleaned Up Name" } }).display_name).toBe("Cleaned Up Name");
  });

  test("institution override wins over acct.org.name", () => {
    expect(discover("X", "100.00", { a: { institution: "U.S. Bank" } }).institution).toBe("U.S. Bank");
  });

  test("balance < 0 takes priority over name keywords", () => {
    expect(discover("savings overdraft", "-1.00").type).toBe("credit");
  });
});

describe("mapSimpleFinResponses — multi-window merge", () => {
  test("most-recent window's account snapshot wins (balance, name, holdings)", () => {
    const older: SimpleFinAccountsResponse = {
      accounts: [{
        id: "a", name: "OLD NAME", currency: "USD", balance: "100.00",
        transactions: [{ id: "t-old", posted: 1700000000, amount: "10.00", description: "first sight" }],
        holdings: [{ symbol: "VTI", shares: "5", market_value: "1000.00" }],
      }],
      errlist: [],
    };
    const newer: SimpleFinAccountsResponse = {
      accounts: [{
        id: "a", name: "NEW NAME", currency: "USD", balance: "200.00",
        transactions: [{ id: "t-new", posted: 1700001000, amount: "20.00", description: "newer txn" }],
        holdings: [{ symbol: "VTI", shares: "10", market_value: "2500.00" }],
      }],
      errlist: [],
    };
    const ops = mapSimpleFinResponses({ responses: [older, newer], asOf: "2026-05-01", overrides: {} });

    const disc = ops.find((o) => o.kind === "account_discovery");
    expect((disc!.draft as { display_name: string }).display_name).toBe("NEW NAME");

    const ass = ops.find((o) => o.kind === "assertion");
    expect((ass!.draft as { expected_usd: number }).expected_usd).toBe(200);

    const pos = ops.find((o) => o.kind === "position_snapshot");
    expect((pos!.draft as { qty: number; price_usd: number | null }).qty).toBe(10);
    expect((pos!.draft as { qty: number; price_usd: number | null }).price_usd).toBe(250);
  });

  test("transactions union by id across windows; first occurrence wins on conflict", () => {
    const older: SimpleFinAccountsResponse = {
      accounts: [{
        id: "a", name: "A", currency: "USD", balance: "0",
        transactions: [
          { id: "t-shared", posted: 1700000000, amount: "10.00", description: "FIRST VERSION" },
          { id: "t-only-old", posted: 1700000100, amount: "20.00", description: "old only" },
        ],
      }],
      errlist: [],
    };
    const newer: SimpleFinAccountsResponse = {
      accounts: [{
        id: "a", name: "A", currency: "USD", balance: "0",
        transactions: [
          { id: "t-shared", posted: 1700000000, amount: "10.00", description: "SECOND VERSION" },
          { id: "t-only-new", posted: 1700000200, amount: "30.00", description: "new only" },
        ],
      }],
      errlist: [],
    };
    const ops = mapSimpleFinResponses({ responses: [older, newer], asOf: "2026-05-01", overrides: {} });

    const oneSided = ops.filter((o) => o.kind === "one_sided");
    expect(oneSided).toHaveLength(3);

    const shared = oneSided.find((o) => (o.draft as { description: string | null }).description?.includes("VERSION"))!;
    expect((shared.draft as { description: string }).description).toBe("FIRST VERSION");
  });

  test("account that appears only in an older window is still emitted", () => {
    const older: SimpleFinAccountsResponse = {
      accounts: [
        { id: "stale", name: "Stale", currency: "USD", balance: "5.00", transactions: [] },
        { id: "current", name: "Current Old", currency: "USD", balance: "10.00", transactions: [] },
      ],
      errlist: [],
    };
    const newer: SimpleFinAccountsResponse = {
      accounts: [
        { id: "current", name: "Current New", currency: "USD", balance: "20.00", transactions: [] },
      ],
      errlist: [],
    };
    const ops = mapSimpleFinResponses({ responses: [older, newer], asOf: "2026-05-01", overrides: {} });

    const disc = ops.filter((o) => o.kind === "account_discovery");
    expect(disc).toHaveLength(2);
    const ids = disc.map((o) => (o.draft as { id: string }).id).sort();
    expect(ids).toEqual(["simplefin:current", "simplefin:stale"]);

    const currentDisc = disc.find((o) => (o.draft as { id: string }).id === "simplefin:current")!;
    expect((currentDisc.draft as { display_name: string }).display_name).toBe("Current New");
  });

  test("errlist is union across windows, dedup by string equality", () => {
    const older: SimpleFinAccountsResponse = {
      accounts: [], errlist: ["error A", "error B"],
    };
    const newer: SimpleFinAccountsResponse = {
      accounts: [], errlist: ["error B", "error C"],
    };
    const ops = mapSimpleFinResponses({ responses: [older, newer], asOf: "2026-05-01", overrides: {} });

    const warnings = ops.filter((o) => o.kind === "sync_warning");
    expect(warnings.map((w) => w.warning.message)).toEqual(["error A", "error B", "error C"]);
  });

  test("account_discovery emitted exactly once per sf_id even across many windows", () => {
    const responses: SimpleFinAccountsResponse[] = [
      { accounts: [{ id: "a", name: "A", currency: "USD", balance: "0", transactions: [] }], errlist: [] },
      { accounts: [{ id: "a", name: "A", currency: "USD", balance: "0", transactions: [] }], errlist: [] },
      { accounts: [{ id: "a", name: "A", currency: "USD", balance: "0", transactions: [] }], errlist: [] },
    ];
    const ops = mapSimpleFinResponses({ responses, asOf: "2026-05-01", overrides: {} });
    expect(ops.filter((o) => o.kind === "account_discovery")).toHaveLength(1);
  });
});
