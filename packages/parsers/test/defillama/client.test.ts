import { describe, expect, test } from "bun:test";
import { fetchChartChunk, USER_AGENT } from "../../src/defillama/client";
import type { FetchJson, FetchJsonOpts } from "../../src/types/http";

interface Captured {
  url: string | URL;
  opts: FetchJsonOpts | undefined;
}

function stubFetchJson(responder: (call: Captured) => unknown): {
  fetchJson: FetchJson;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchJson: FetchJson = async <T>(url: string | URL, opts?: FetchJsonOpts): Promise<T> => {
    const captured: Captured = { url, opts };
    calls.push(captured);
    return responder(captured) as T;
  };
  return { fetchJson, calls };
}

describe("USER_AGENT", () => {
  test("is the canonical finance-parsers value", () => {
    expect(USER_AGENT).toBe("finance-parsers/defillama");
  });
});

describe("fetchChartChunk", () => {
  test("builds the correct URL with span, period, and start", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({ coins: {} }));
    await fetchChartChunk({
      fetchJson,
      baseUrl: "https://coins.llama.fi",
      coinKey: "coingecko:ethereum",
      startUnix: 1700000000,
    });
    expect(calls).toHaveLength(1);
    const url = String(calls[0]!.url);
    expect(url).toBe(
      "https://coins.llama.fi/chart/coingecko%3Aethereum?start=1700000000&span=500&period=1d",
    );
  });

  test("sets the user-agent header", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({ coins: {} }));
    await fetchChartChunk({
      fetchJson,
      baseUrl: "https://coins.llama.fi",
      coinKey: "coingecko:bitcoin",
      startUnix: 1700000000,
    });
    expect(calls[0]!.opts?.headers).toMatchObject({ "user-agent": USER_AGENT });
  });

  test("normalizes the response key (request key differs from response key)", async () => {
    const { fetchJson } = stubFetchJson(() => ({
      coins: {
        "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
          symbol: "USDC",
          prices: [
            { timestamp: 1700000000, price: 1.0001, confidence: 0.99 },
          ],
        },
      },
    }));
    const { points } = await fetchChartChunk({
      fetchJson,
      baseUrl: "https://coins.llama.fi",
      coinKey: "ethereum:0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48",  // different case
      startUnix: 1700000000,
    });
    expect(points).toEqual([{ ts: 1700000000, price: 1.0001 }]);
  });

  test("returns empty points when coins object is empty (unknown coin_key)", async () => {
    const { fetchJson } = stubFetchJson(() => ({ coins: {} }));
    const { points } = await fetchChartChunk({
      fetchJson,
      baseUrl: "https://coins.llama.fi",
      coinKey: "coingecko:does-not-exist",
      startUnix: 1700000000,
    });
    expect(points).toEqual([]);
  });

  test("filters malformed price rows (NaN price, missing timestamp)", async () => {
    const { fetchJson } = stubFetchJson(() => ({
      coins: {
        "coingecko:ethereum": {
          symbol: "ETH",
          prices: [
            { timestamp: 1700000000, price: 2500.0 },
            { timestamp: 1700086400, price: NaN },                // dropped
            { price: 2510.0 } as { timestamp: number; price: number }, // missing ts → dropped
            { timestamp: 1700172800, price: 2520.0 },
          ],
        },
      },
    }));
    const { points } = await fetchChartChunk({
      fetchJson,
      baseUrl: "https://coins.llama.fi",
      coinKey: "coingecko:ethereum",
      startUnix: 1700000000,
    });
    expect(points).toEqual([
      { ts: 1700000000, price: 2500.0 },
      { ts: 1700172800, price: 2520.0 },
    ]);
  });
});
