import { describe, expect, test } from "bun:test";
import {
  CHAIN_INFO,
  SUPPORTED_CHAINS,
  alchemyUrl,
} from "../../src/alchemy/chains";

describe("SUPPORTED_CHAINS", () => {
  test("contains the 5 Alchemy-supported chains in canonical order", () => {
    expect([...SUPPORTED_CHAINS]).toEqual([
      "ethereum", "base", "polygon", "optimism", "arbitrum",
    ]);
  });
});

describe("CHAIN_INFO", () => {
  test("has an entry for every supported chain", () => {
    for (const chain of SUPPORTED_CHAINS) {
      expect(CHAIN_INFO[chain]).toBeDefined();
    }
  });

  test("ethereum is ETH 18-dec on eth-mainnet", () => {
    expect(CHAIN_INFO.ethereum).toEqual({
      urlSlug: "eth-mainnet",
      nativeSymbol: "ETH",
      nativeDecimals: 18,
    });
  });

  test("polygon is MATIC 18-dec on polygon-mainnet", () => {
    expect(CHAIN_INFO.polygon).toEqual({
      urlSlug: "polygon-mainnet",
      nativeSymbol: "MATIC",
      nativeDecimals: 18,
    });
  });

  test("base / optimism / arbitrum are all ETH 18-dec with their own slugs", () => {
    expect(CHAIN_INFO.base.nativeSymbol).toBe("ETH");
    expect(CHAIN_INFO.base.urlSlug).toBe("base-mainnet");
    expect(CHAIN_INFO.optimism.nativeSymbol).toBe("ETH");
    expect(CHAIN_INFO.optimism.urlSlug).toBe("opt-mainnet");
    expect(CHAIN_INFO.arbitrum.nativeSymbol).toBe("ETH");
    expect(CHAIN_INFO.arbitrum.urlSlug).toBe("arb-mainnet");
  });
});

describe("alchemyUrl", () => {
  test("composes the {slug}.g.alchemy.com/v2/{key} URL", () => {
    expect(alchemyUrl("ethereum", "abc123"))
      .toBe("https://eth-mainnet.g.alchemy.com/v2/abc123");
    expect(alchemyUrl("polygon", "K-9.tok"))
      .toBe("https://polygon-mainnet.g.alchemy.com/v2/K-9.tok");
  });
});
