import { describe, expect, test } from "bun:test";
import { NullPriceProvider, MapPriceProvider } from "../../src/types/price-provider";

describe("NullPriceProvider", () => {
  test("always returns null", async () => {
    const p = new NullPriceProvider();
    expect(await p.getPrice({ symbol: "USDC", as_of: "2024-01-01" })).toBeNull();
    expect(await p.getPrice({ symbol: "BTC", chain: "bitcoin", as_of: "2024-06-15" })).toBeNull();
  });
});

describe("MapPriceProvider", () => {
  test("returns seeded prices keyed by symbol:as_of", async () => {
    const p = new MapPriceProvider({
      "USDC:2024-01-01": 1.0,
      "BTC:2024-06-15": 65000,
    });
    const usdc = await p.getPrice({ symbol: "USDC", as_of: "2024-01-01" });
    expect(usdc).toEqual({ price_usd: 1.0, as_of: "2024-01-01", source: "test" });
    const btc = await p.getPrice({ symbol: "BTC", as_of: "2024-06-15" });
    expect(btc).toEqual({ price_usd: 65000, as_of: "2024-06-15", source: "test" });
  });

  test("returns null for unseeded keys", async () => {
    const p = new MapPriceProvider({ "USDC:2024-01-01": 1.0 });
    expect(await p.getPrice({ symbol: "USDC", as_of: "2024-01-02" })).toBeNull();
    expect(await p.getPrice({ symbol: "ETH", as_of: "2024-01-01" })).toBeNull();
  });

  test("ignores chain and contract_address (symbol+date only)", async () => {
    const p = new MapPriceProvider({ "USDC:2024-01-01": 1.0 });
    const result = await p.getPrice({
      symbol: "USDC",
      chain: "ethereum",
      contract_address: "0xabc",
      as_of: "2024-01-01",
    });
    expect(result?.price_usd).toBe(1.0);
  });
});
