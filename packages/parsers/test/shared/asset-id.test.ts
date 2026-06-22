import { describe, expect, test } from "bun:test";
import {
  makeAssetId,
  makeErc20AssetId,
  makeFiatAssetId,
  makeNativeAssetId,
  makeSplTokenAssetId,
} from "../../src/shared/ids/asset-id";

describe("makeErc20AssetId", () => {
  test("formats and lowercases an Ethereum mainnet ERC-20", () => {
    expect(
      makeErc20AssetId(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    ).toBe("eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  });

  test("formats Polygon ERC-20", () => {
    expect(makeErc20AssetId(137, "0xDEADbeef00000000000000000000000000000000")).toBe(
      "eip155:137/erc20:0xdeadbeef00000000000000000000000000000000",
    );
  });
});

describe("makeNativeAssetId", () => {
  test("ETH on Ethereum mainnet → slip44:60", () => {
    expect(makeNativeAssetId(1)).toBe("eip155:1/slip44:60");
  });

  test("MATIC on Polygon → slip44:966", () => {
    expect(makeNativeAssetId(137)).toBe("eip155:137/slip44:966");
  });

  test("ETH on Optimism (chain 10) inherits slip44:60", () => {
    expect(makeNativeAssetId(10)).toBe("eip155:10/slip44:60");
  });

  test("ETH on Arbitrum (chain 42161) inherits slip44:60", () => {
    expect(makeNativeAssetId(42161)).toBe("eip155:42161/slip44:60");
  });

  test("ETH on Base (chain 8453) inherits slip44:60", () => {
    expect(makeNativeAssetId(8453)).toBe("eip155:8453/slip44:60");
  });

  test("throws on unknown chain id", () => {
    expect(() => makeNativeAssetId(99999)).toThrow(/unknown chain/i);
  });
});

describe("makeSplTokenAssetId", () => {
  test("formats Solana SPL token", () => {
    expect(makeSplTokenAssetId("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(
      "solana:mainnet/spl-token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
  });
});

describe("makeFiatAssetId", () => {
  test("formats fiat USD", () => {
    expect(makeFiatAssetId("USD")).toBe("fiat:USD");
  });

  test("preserves the caller's case (ISO codes are uppercase already)", () => {
    expect(makeFiatAssetId("EUR")).toBe("fiat:EUR");
  });
});

describe("makeAssetId (escape hatch)", () => {
  test("composes parts verbatim", () => {
    expect(
      makeAssetId({
        chain: "bip122",
        chainRef: "000000000019d6689c085ae165831e93",
        namespace: "slip44",
        reference: "0",
      }),
    ).toBe("bip122:000000000019d6689c085ae165831e93/slip44:0");
  });
});
