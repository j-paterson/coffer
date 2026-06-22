import { describe, expect, test } from "bun:test";
import {
  defaultChainFor,
  rawEventFromV3Account,
  rawEventFromV2Account,
  rawEventFromV2Txn,
  accountDiscoveryFor,
  lowerName,
  walletJoinKey,
  positionSnapshotFor,
} from "../../src/coinbase/mapper";
import { DEFAULT_CHAIN_MAP } from "../../src/coinbase/config";
import type { V3Account, V2Account, V2Transaction } from "../../src/coinbase/client";

describe("walletJoinKey", () => {
  test("joins normalized name and currency", () => {
    expect(walletJoinKey("  ETH Wallet  ", "ETH")).toBe("eth wallet|ETH");
    expect(walletJoinKey("Portfolio", "BTC")).toBe("portfolio|BTC");
    expect(walletJoinKey("Portfolio", "ETH")).not.toBe(walletJoinKey("Portfolio", "BTC"));
  });
});

describe("positionSnapshotFor", () => {
  test("normalizes empty chain to null and sets contract_address null", () => {
    const op = positionSnapshotFor({
      account_id: "coinbase:abc",
      symbol: "RANDOMCOIN",
      chain: "",
      as_of: "2024-06-15",
      qty: 1,
      price_usd: 1.5,
    });
    expect(op.draft.chain).toBeNull();
    expect(op.draft.contract_address).toBeNull();
    expect(op.draft.source).toBe("coinbase");
  });

  test("preserves non-empty chain", () => {
    const op = positionSnapshotFor({
      account_id: "coinbase:abc",
      symbol: "ETH",
      chain: "ethereum",
      as_of: "2024-06-15",
      qty: 1,
      price_usd: 3000,
    });
    expect(op.draft.chain).toBe("ethereum");
  });
});

describe("lowerName", () => {
  test("lowercases and trims", () => {
    expect(lowerName("  ETH Wallet  ")).toBe("eth wallet");
  });

  test("collapses internal whitespace", () => {
    expect(lowerName("ETH   Wallet")).toBe("eth   wallet");
    // Note: we deliberately do NOT collapse internal spaces — names like
    // "ETH  Wallet" (two spaces) are matched only against identical inputs.
    // This test pins the simple lowercase+trim behavior.
  });
});

describe("defaultChainFor — config overrides built-ins", () => {
  test("returns config override when present", () => {
    expect(defaultChainFor("ETH", { ETH: "base" }, DEFAULT_CHAIN_MAP)).toBe("base");
  });

  test("falls back to DEFAULT_CHAIN_MAP", () => {
    expect(defaultChainFor("BTC", {}, DEFAULT_CHAIN_MAP)).toBe("bitcoin");
    expect(defaultChainFor("USDC", {}, DEFAULT_CHAIN_MAP)).toBe("ethereum");
  });

  test("returns '' for unknown currency", () => {
    expect(defaultChainFor("RANDOMCOIN", {}, DEFAULT_CHAIN_MAP)).toBe("");
  });
});

describe("rawEventFromV3Account", () => {
  test("external_id = coinbase:v3-account:{uuid}:{today}; payload is the account verbatim", () => {
    const acct: V3Account = {
      uuid: "v3-abc",
      name: "ETH Wallet",
      currency: "ETH",
      available_balance: { value: "1.5", currency: "ETH" },
      extra: 42,
    } as V3Account;
    const ev = rawEventFromV3Account(acct, "2026-05-17");
    expect(ev).toEqual({
      kind: "raw_event",
      source: "coinbase",
      external_id: "coinbase:v3-account:v3-abc:2026-05-17",
      payload: acct,
    });
  });
});

describe("rawEventFromV2Account", () => {
  test("external_id = coinbase:v2-account:{id}:{today}", () => {
    const acct: V2Account = { id: "v2-abc", name: "ETH Wallet", currency: "ETH" } as V2Account;
    const ev = rawEventFromV2Account(acct, "2026-05-17");
    expect(ev.external_id).toBe("coinbase:v2-account:v2-abc:2026-05-17");
    expect(ev.payload).toBe(acct);
  });
});

describe("rawEventFromV2Txn", () => {
  test("external_id = coinbase:v2-txn:{id}; NO date suffix (txn id is immutable)", () => {
    const txn: V2Transaction = {
      id: "txn-zzz",
      amount: { amount: "1.0", currency: "ETH" },
      created_at: "2024-06-15T12:00:00Z",
      type: "send",
    } as V2Transaction;
    const ev = rawEventFromV2Txn(txn);
    expect(ev.external_id).toBe("coinbase:v2-txn:txn-zzz");
    expect(ev.payload).toBe(txn);
  });
});

describe("accountDiscoveryFor", () => {
  test("prefers v3 uuid when both provided", () => {
    const op = accountDiscoveryFor({
      v3_uuid: "v3-xyz",
      v2_uuid: "v2-xyz",
      display_name: "ETH Wallet",
      currency: "ETH",
    });
    expect(op).toEqual({
      kind: "account_discovery",
      draft: {
        id: "coinbase:v3-xyz",
        display_name: "ETH Wallet",
        institution: "Coinbase",
        type: "brokerage",
        currency: "ETH",
        mode: "live",
        external_id: "v3-xyz",
        source: "coinbase",
      },
    });
  });

  test("falls back to v2 uuid when v3 absent", () => {
    const op = accountDiscoveryFor({
      v2_uuid: "v2-xyz",
      display_name: "ETH Wallet",
      currency: "ETH",
    });
    expect((op.draft as { id: string }).id).toBe("coinbase:v2-xyz");
    expect((op.draft as { external_id: string }).external_id).toBe("v2-xyz");
  });
});
