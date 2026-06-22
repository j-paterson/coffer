import { describe, expect, test } from "bun:test";
import {
  basicAuthHeader,
  fetchPositions,
  fetchWalletChart,
  fetchFungibleChart,
  USER_AGENT,
} from "../../src/zerion/client";
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
    expect(USER_AGENT).toBe("finance-parsers/zerion");
  });
});

describe("basicAuthHeader", () => {
  test("appends a trailing colon (key as username, empty password)", () => {
    // btoa("zk_dev_abc123:") = "emtfZGV2X2FiYzEyMzo="
    expect(basicAuthHeader("zk_dev_abc123")).toBe("Basic emtfZGV2X2FiYzEyMzo=");
  });

  test("handles arbitrary characters", () => {
    // The key flows through verbatim; only the trailing ':' is added.
    expect(basicAuthHeader("KEY")).toBe("Basic " + btoa("KEY:"));
  });
});

describe("fetchPositions", () => {
  const AUTH = basicAuthHeader("test-key");
  const COMMON = {
    baseUrl: "https://api.zerion.io/v1",
    basicAuthHeader: AUTH,
    userAgent: USER_AGENT,
  };

  test("builds the correct URL with all required query params, address lowercased", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({ data: [], links: { next: null } }));
    await fetchPositions({
      fetchJson,
      ...COMMON,
      address: "0xABCDEF0123456789ABCDEF0123456789ABCDEF01",
    });
    expect(calls).toHaveLength(1);
    const url = String(calls[0]!.url);
    expect(url).toBe(
      "https://api.zerion.io/v1/wallets/0xabcdef0123456789abcdef0123456789abcdef01/positions/" +
      "?currency=usd&filter%5Btrash%5D=only_non_trash&page%5Bsize%5D=100",
    );
  });

  test("sets Authorization, User-Agent, and Accept headers", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({ data: [], links: { next: null } }));
    await fetchPositions({
      fetchJson,
      ...COMMON,
      address: "0xabcdef0123456789abcdef0123456789abcdef01",
    });
    expect(calls[0]!.opts?.headers).toMatchObject({
      authorization: AUTH,
      "user-agent": USER_AGENT,
      accept: "application/json",
    });
  });

  test("returns response when links.next is null after one page", async () => {
    const page = {
      data: [{ id: "p1", type: "positions", attributes: {}, relationships: {} }],
      links: { next: null },
    };
    const { fetchJson, calls } = stubFetchJson(() => page);
    const result = await fetchPositions({
      fetchJson,
      ...COMMON,
      address: "0xabcdef0123456789abcdef0123456789abcdef01",
    });
    expect(calls).toHaveLength(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.id).toBe("p1");
  });

  test("follows links.next, concatenating data across pages", async () => {
    const pageA = {
      data: [{ id: "p1", type: "positions", attributes: {}, relationships: {} }],
      links: { next: "https://api.zerion.io/v1/wallets/0xa/positions/?page%5Bafter%5D=cursorA" },
    };
    const pageB = {
      data: [
        { id: "p2", type: "positions", attributes: {}, relationships: {} },
        { id: "p3", type: "positions", attributes: {}, relationships: {} },
      ],
      links: { next: null },
    };
    const { fetchJson, calls } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.includes("page%5Bafter%5D=cursorA")) return pageB;
      return pageA;
    });
    const result = await fetchPositions({
      fetchJson,
      ...COMMON,
      address: "0xabcdef0123456789abcdef0123456789abcdef01",
    });
    expect(calls).toHaveLength(2);
    expect(result.data).toHaveLength(3);
    expect(result.data.map((r) => r.id)).toEqual(["p1", "p2", "p3"]);
  });

  test("treats missing links / links.next as a stop signal", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({ data: [{ id: "only", type: "positions", attributes: {}, relationships: {} }] }));
    const result = await fetchPositions({
      fetchJson,
      ...COMMON,
      address: "0xabcdef0123456789abcdef0123456789abcdef01",
    });
    expect(calls).toHaveLength(1);
    expect(result.data).toHaveLength(1);
  });

  test("treats missing data as empty array (defensive)", async () => {
    const { fetchJson } = stubFetchJson(() => ({ links: { next: null } }));
    const result = await fetchPositions({
      fetchJson,
      ...COMMON,
      address: "0xabcdef0123456789abcdef0123456789abcdef01",
    });
    expect(result.data).toEqual([]);
  });
});

describe("fetchWalletChart", () => {
  const AUTH = basicAuthHeader("test-key");
  const COMMON = {
    baseUrl: "https://api.zerion.io/v1",
    basicAuthHeader: AUTH,
    userAgent: USER_AGENT,
  };

  test("builds URL with chain filter, address lowercased", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({ data: { attributes: { points: [] } } }));
    await fetchWalletChart({
      fetchJson,
      ...COMMON,
      address: "0xABCDEF0123456789ABCDEF0123456789ABCDEF01",
      chain: "ethereum",
    });
    expect(calls).toHaveLength(1);
    const url = String(calls[0]!.url);
    expect(url).toBe(
      "https://api.zerion.io/v1/wallets/0xabcdef0123456789abcdef0123456789abcdef01/charts/year" +
      "?currency=usd&filter%5Bchain_ids%5D=ethereum",
    );
  });

  test("sets the three headers", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({ data: { attributes: { points: [] } } }));
    await fetchWalletChart({
      fetchJson,
      ...COMMON,
      address: "0xabcdef0123456789abcdef0123456789abcdef01",
      chain: "base",
    });
    expect(calls[0]!.opts?.headers).toMatchObject({
      authorization: AUTH,
      "user-agent": USER_AGENT,
      accept: "application/json",
    });
  });

  test("returns the response shape verbatim", async () => {
    const fixture = {
      data: {
        type: "charts",
        attributes: { points: [[1700000000, 12345.67], [1700604800, 12500.10]] },
      },
    };
    const { fetchJson } = stubFetchJson(() => fixture);
    const result = await fetchWalletChart({
      fetchJson,
      ...COMMON,
      address: "0xabcdef0123456789abcdef0123456789abcdef01",
      chain: "ethereum",
    });
    expect(result.data.attributes.points).toEqual([[1700000000, 12345.67], [1700604800, 12500.10]]);
  });
});

describe("fetchFungibleChart", () => {
  const AUTH = basicAuthHeader("test-key");
  const COMMON = {
    baseUrl: "https://api.zerion.io/v1",
    basicAuthHeader: AUTH,
    userAgent: USER_AGENT,
  };

  test("builds URL with fungible id (URL-encoded)", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({
      data: { attributes: { symbol: "ETH", implementations: [], points: [] } },
    }));
    await fetchFungibleChart({
      fetchJson,
      ...COMMON,
      fungibleId: "fungible-uuid-with-dashes",
    });
    expect(calls).toHaveLength(1);
    const url = String(calls[0]!.url);
    expect(url).toBe(
      "https://api.zerion.io/v1/fungibles/fungible-uuid-with-dashes/charts/year?currency=usd",
    );
  });

  test("URL-encodes fungible ids containing reserved characters", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({
      data: { attributes: { symbol: "X", implementations: [], points: [] } },
    }));
    await fetchFungibleChart({
      fetchJson,
      ...COMMON,
      fungibleId: "weird id/with chars",
    });
    const url = String(calls[0]!.url);
    expect(url).toBe(
      "https://api.zerion.io/v1/fungibles/weird%20id%2Fwith%20chars/charts/year?currency=usd",
    );
  });

  test("sets the three headers", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({
      data: { attributes: { symbol: "X", implementations: [], points: [] } },
    }));
    await fetchFungibleChart({ fetchJson, ...COMMON, fungibleId: "x" });
    expect(calls[0]!.opts?.headers).toMatchObject({
      authorization: AUTH,
      "user-agent": USER_AGENT,
      accept: "application/json",
    });
  });

  test("returns the response shape verbatim (symbol, implementations, points)", async () => {
    const fixture = {
      data: {
        attributes: {
          symbol: "USDC",
          implementations: [
            { chain_id: "ethereum", address: "0xa0b8...", decimals: 6 },
            { chain_id: "base",     address: "0x8335...", decimals: 6 },
          ],
          points: [[1700000000, 1.0001], [1700604800, 1.0002]],
        },
      },
    };
    const { fetchJson } = stubFetchJson(() => fixture);
    const result = await fetchFungibleChart({
      fetchJson,
      ...COMMON,
      fungibleId: "usdc-uuid",
    });
    expect(result.data.attributes.symbol).toBe("USDC");
    expect(result.data.attributes.implementations).toHaveLength(2);
    expect(result.data.attributes.points).toHaveLength(2);
  });
});
