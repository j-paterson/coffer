import { describe, expect, test } from "bun:test";
import {
  fetchPoolList,
  fetchOhlcv,
  USER_AGENT,
  type GeckoTerminalPoolListResponse,
  type GeckoTerminalOhlcvResponse,
} from "../../src/geckoterminal/client";
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
    expect(USER_AGENT).toBe("finance-parsers/geckoterminal");
  });
});

describe("fetchPoolList", () => {
  test("builds URL and sends Accept header", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({ data: [] } satisfies GeckoTerminalPoolListResponse));
    await fetchPoolList({
      fetchJson,
      network: "eth",
      contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.url)).toBe(
      "https://api.geckoterminal.com/api/v2/networks/eth/tokens/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/pools?page=1",
    );
    expect(calls[0]!.opts?.headers).toEqual({
      accept: "application/json",
      "user-agent": USER_AGENT,
    });
    expect(calls[0]!.opts?.method ?? "GET").toBe("GET");
  });

  test("lowercases the contract in the URL", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({ data: [] }));
    await fetchPoolList({
      fetchJson,
      network: "eth",
      contract: "0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48",
    });
    expect(String(calls[0]!.url)).toContain("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  });

  test("returns the parsed response shape unchanged", async () => {
    const response: GeckoTerminalPoolListResponse = {
      data: [
        { id: "eth_0xpool", type: "pool", attributes: { reserve_in_usd: "12345.67" } },
      ],
    };
    const { fetchJson } = stubFetchJson(() => response);
    const result = await fetchPoolList({
      fetchJson,
      network: "eth",
      contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    });
    expect(result).toEqual(response);
  });
});

describe("fetchOhlcv", () => {
  test("builds URL with aggregate=1, limit=1000, no before_timestamp by default", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({
      data: { attributes: { ohlcv_list: [] } },
    } satisfies GeckoTerminalOhlcvResponse));
    await fetchOhlcv({
      fetchJson,
      network: "eth",
      pool: "0xpool",
    });
    expect(calls).toHaveLength(1);
    const url = new URL(String(calls[0]!.url));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://api.geckoterminal.com/api/v2/networks/eth/pools/0xpool/ohlcv/day",
    );
    expect(url.searchParams.get("aggregate")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("1000");
    expect(url.searchParams.get("before_timestamp")).toBeNull();
    expect(calls[0]!.opts?.headers).toEqual({
      accept: "application/json",
      "user-agent": USER_AGENT,
    });
  });

  test("appends before_timestamp when provided", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({ data: { attributes: { ohlcv_list: [] } } }));
    await fetchOhlcv({
      fetchJson,
      network: "base",
      pool: "0xpool",
      beforeTimestamp: 1715731200,
    });
    const url = new URL(String(calls[0]!.url));
    expect(url.searchParams.get("before_timestamp")).toBe("1715731200");
  });

  test("returns the parsed response shape unchanged", async () => {
    const response: GeckoTerminalOhlcvResponse = {
      data: { attributes: { ohlcv_list: [[1715731200, 0.5, 0.6, 0.4, 0.55, 12345]] } },
    };
    const { fetchJson } = stubFetchJson(() => response);
    const result = await fetchOhlcv({
      fetchJson,
      network: "eth",
      pool: "0xpool",
    });
    expect(result).toEqual(response);
  });
});
