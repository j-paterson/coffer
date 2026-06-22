import { describe, expect, test } from "bun:test";
import { hexToQty, buildAccountDraft, buildNativePosition, buildTokenPosition } from "../../src/alchemy/mapper";

describe("hexToQty", () => {
  test("converts a typical 18-dec wei balance to ETH", () => {
    // 0x16345785d8a0000 = 100_000_000_000_000_000 wei = 0.1 ETH
    expect(hexToQty("0x16345785d8a0000", 18)).toBeCloseTo(0.1, 12);
  });

  test("converts a USDC raw balance to decimal (6 decimals)", () => {
    // 0x3b9aca00 = 1_000_000_000 base units = 1000 USDC at 6 decimals
    expect(hexToQty("0x3b9aca00", 6)).toBe(1000);
  });

  test("returns 0 for '0x'", () => {
    expect(hexToQty("0x", 18)).toBe(0);
  });

  test("returns 0 for '0x0'", () => {
    expect(hexToQty("0x0", 18)).toBe(0);
  });

  test("returns 0 for an unparseable string", () => {
    expect(hexToQty("not-hex", 18)).toBe(0);
    expect(hexToQty("", 18)).toBe(0);
    expect(hexToQty("0xZZ", 18)).toBe(0);
  });

  test("handles a very large value (precision-lossy but non-zero)", () => {
    // 0xde0b6b3a7640000 = 1e18 = 1 ETH
    expect(hexToQty("0xde0b6b3a7640000", 18)).toBeCloseTo(1.0, 12);
  });

  test("decimals=0 returns the integer count itself", () => {
    expect(hexToQty("0x2a", 0)).toBe(42);
  });
});

describe("buildAccountDraft", () => {
  test("account id uses zerion: prefix (cross-vendor convention)", () => {
    const draft = buildAccountDraft("ethereum", "0xABCDEF0123456789abcdef0123456789ABCDEF01");
    expect(draft.id).toBe("zerion:ethereum:0xabcdef0123456789abcdef0123456789abcdef01");
    expect(draft.external_id).toBe(draft.id);
  });

  test("display_name title-cases chain and shortens address with U+2026 ellipsis", () => {
    const draft = buildAccountDraft("base", "0x0123456789abcdef0123456789abcdef01234567");
    // 0x0123…4567 — U+2026 horizontal ellipsis, NOT three ASCII dots
    expect(draft.display_name).toBe("Base 0x0123…4567");
  });

  test("institution is 'alchemy', source is 'alchemy', mode is 'live'", () => {
    const draft = buildAccountDraft("polygon", "0xabcdef0123456789abcdef0123456789abcdef01");
    expect(draft.institution).toBe("alchemy");
    expect(draft.source).toBe("alchemy");
    expect(draft.mode).toBe("live");
    expect(draft.type).toBe("crypto");
    expect(draft.currency).toBe("USD");
  });

  test("lowercases mixed-case addresses for the id", () => {
    const upper = "0xABCDEF0123456789ABCDEF0123456789ABCDEF01";
    const lower = "0xabcdef0123456789abcdef0123456789abcdef01";
    expect(buildAccountDraft("optimism", upper).id).toBe(`zerion:optimism:${lower}`);
  });
});

describe("buildNativePosition", () => {
  test("ethereum native is ETH 18-dec, contract_address null", () => {
    const pos = buildNativePosition({
      chain: "ethereum",
      accountId: "zerion:ethereum:0xa",
      qty: 1.5,
      asOf: "2026-05-14",
    });
    expect(pos).toEqual({
      account_id: "zerion:ethereum:0xa",
      symbol: "ETH",
      chain: "ethereum",
      contract_address: null,
      as_of: "2026-05-14",
      qty: 1.5,
      price_usd: null,
      source: "alchemy",
    });
  });

  test("polygon native is MATIC", () => {
    const pos = buildNativePosition({
      chain: "polygon",
      accountId: "zerion:polygon:0xa",
      qty: 100,
      asOf: "2026-05-14",
    });
    expect(pos.symbol).toBe("MATIC");
    expect(pos.chain).toBe("polygon");
  });
});

describe("buildTokenPosition", () => {
  test("happy path: returns a snapshot with lowercased contract", () => {
    const pos = buildTokenPosition({
      chain: "ethereum",
      accountId: "zerion:ethereum:0xa",
      contract: "0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48",
      rawHex: "0x3b9aca00",  // 1_000_000_000 base
      metadata: { symbol: "USDC", decimals: 6 },
      asOf: "2026-05-14",
    });
    expect(pos).not.toBeNull();
    expect(pos!.account_id).toBe("zerion:ethereum:0xa");
    expect(pos!.symbol).toBe("USDC");
    expect(pos!.chain).toBe("ethereum");
    expect(pos!.contract_address).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(pos!.qty).toBe(1000);
    expect(pos!.price_usd).toBeNull();
    expect(pos!.source).toBe("alchemy");
  });

  test("returns null when metadata.symbol is missing or empty", () => {
    expect(buildTokenPosition({
      chain: "ethereum",
      accountId: "id",
      contract: "0xa",
      rawHex: "0x1",
      metadata: { decimals: 6 },
      asOf: "2026-05-14",
    })).toBeNull();
    expect(buildTokenPosition({
      chain: "ethereum",
      accountId: "id",
      contract: "0xa",
      rawHex: "0x1",
      metadata: { symbol: "   ", decimals: 6 },
      asOf: "2026-05-14",
    })).toBeNull();
  });

  test("returns null when metadata.decimals is missing or non-numeric", () => {
    expect(buildTokenPosition({
      chain: "ethereum",
      accountId: "id",
      contract: "0xa",
      rawHex: "0x1",
      metadata: { symbol: "X" },
      asOf: "2026-05-14",
    })).toBeNull();
    expect(buildTokenPosition({
      chain: "ethereum",
      accountId: "id",
      contract: "0xa",
      rawHex: "0x1",
      metadata: { symbol: "X", decimals: -1 },
      asOf: "2026-05-14",
    })).toBeNull();
  });

  test("returns null when computed qty is 0 (e.g. dust below decimal precision)", () => {
    expect(buildTokenPosition({
      chain: "ethereum",
      accountId: "id",
      contract: "0xa",
      rawHex: "0x0",
      metadata: { symbol: "X", decimals: 6 },
      asOf: "2026-05-14",
    })).toBeNull();
  });

  test("trims whitespace from symbol", () => {
    const pos = buildTokenPosition({
      chain: "ethereum",
      accountId: "id",
      contract: "0xa",
      rawHex: "0x3b9aca00",
      metadata: { symbol: "  USDC  ", decimals: 6 },
      asOf: "2026-05-14",
    });
    expect(pos!.symbol).toBe("USDC");
  });
});
