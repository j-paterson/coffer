import { describe, expect, test } from "bun:test";
import {
  fetchV3Accounts,
  fetchV2Accounts,
  fetchV2Transactions,
  USER_AGENT,
  type V3Account,
  type V2Account,
  type V2Transaction,
} from "../../src/coinbase/client";
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

const FIXED_JWT = "fixed.jwt.value";
const buildJwt = async () => FIXED_JWT;

const COMMON = {
  baseUrl: "https://api.coinbase.com",
  buildJwt,
  userAgent: USER_AGENT,
};

describe("USER_AGENT", () => {
  test("is the canonical finance-parsers value", () => {
    expect(USER_AGENT).toBe("finance-parsers/coinbase");
  });
});

function v3Account(overrides: Partial<V3Account> = {}): V3Account {
  return {
    uuid: "v3-1",
    name: "ETH Wallet",
    currency: "ETH",
    available_balance: { value: "1.0", currency: "ETH" },
    type: "ACCOUNT_TYPE_CRYPTO",
    ...overrides,
  } as V3Account;
}

describe("fetchV3Accounts — single page", () => {
  test("URL has limit=250 and Authorization=Bearer <jwt>", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({
      accounts: [v3Account()],
      has_next: false,
    }));
    const result = await fetchV3Accounts({ fetchJson, ...COMMON });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.url)).toBe(
      "https://api.coinbase.com/api/v3/brokerage/accounts?limit=250",
    );
    expect(calls[0]!.opts?.headers).toMatchObject({
      authorization: `Bearer ${FIXED_JWT}`,
      "user-agent": USER_AGENT,
      accept: "application/json",
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.uuid).toBe("v3-1");
  });

  test("returns [] on empty response", async () => {
    const { fetchJson } = stubFetchJson(() => ({ accounts: [], has_next: false }));
    const result = await fetchV3Accounts({ fetchJson, ...COMMON });
    expect(result).toEqual([]);
  });
});

describe("fetchV3Accounts — cursor pagination", () => {
  test("follows cursor while has_next is true", async () => {
    const { fetchJson, calls } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.includes("cursor=A")) {
        return { accounts: [v3Account({ uuid: "v3-2", name: "BTC Wallet", currency: "BTC" })], has_next: false };
      }
      return { accounts: [v3Account({ uuid: "v3-1" })], has_next: true, cursor: "A" };
    });
    const result = await fetchV3Accounts({ fetchJson, ...COMMON });
    expect(calls).toHaveLength(2);
    expect(String(calls[0]!.url)).toBe(
      "https://api.coinbase.com/api/v3/brokerage/accounts?limit=250",
    );
    expect(String(calls[1]!.url)).toBe(
      "https://api.coinbase.com/api/v3/brokerage/accounts?limit=250&cursor=A",
    );
    expect(result.map((a) => a.uuid)).toEqual(["v3-1", "v3-2"]);
  });

  test("stops when has_next is false even if cursor present (defensive)", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({
      accounts: [v3Account()],
      has_next: false,
      cursor: "leftover",
    }));
    const result = await fetchV3Accounts({ fetchJson, ...COMMON });
    expect(calls).toHaveLength(1);
    expect(result).toHaveLength(1);
  });
});

describe("fetchV3Accounts — JWT minting", () => {
  test("calls buildJwt with method='GET' and path matching the request", async () => {
    const recorded: Array<{ method: string; path: string; host: string }> = [];
    const tracingBuildJwt = async (args: { method: string; host: string; path: string }) => {
      recorded.push(args);
      return FIXED_JWT;
    };
    const { fetchJson } = stubFetchJson(() => ({ accounts: [], has_next: false }));
    await fetchV3Accounts({
      fetchJson,
      baseUrl: "https://api.coinbase.com",
      buildJwt: tracingBuildJwt,
      userAgent: USER_AGENT,
    });
    expect(recorded).toEqual([
      { method: "GET", host: "api.coinbase.com", path: "/api/v3/brokerage/accounts" },
    ]);
  });
});

function v2Account(overrides: Partial<V2Account> = {}): V2Account {
  return {
    id: "v2-1",
    name: "ETH Wallet",
    currency: "ETH",
    ...overrides,
  } as V2Account;
}

function v2Txn(overrides: Partial<V2Transaction> = {}): V2Transaction {
  return {
    id: "txn-1",
    amount: { amount: "1.0", currency: "ETH" },
    created_at: "2024-06-15T12:00:00Z",
    type: "send",
    ...overrides,
  } as V2Transaction;
}

describe("fetchV2Accounts — single page", () => {
  test("URL is /v2/accounts?limit=100; sends Bearer JWT", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({
      data: [v2Account()],
      pagination: { next_uri: null },
    }));
    const result = await fetchV2Accounts({ fetchJson, ...COMMON });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.url)).toBe("https://api.coinbase.com/v2/accounts?limit=100");
    expect(calls[0]!.opts?.headers).toMatchObject({
      authorization: `Bearer ${FIXED_JWT}`,
      "user-agent": USER_AGENT,
      accept: "application/json",
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("v2-1");
  });
});

describe("fetchV2Accounts — next_uri pagination", () => {
  test("follows pagination.next_uri until null", async () => {
    const { fetchJson, calls } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.endsWith("/v2/accounts?starting_after=A")) {
        return { data: [v2Account({ id: "v2-2", name: "BTC Wallet", currency: "BTC" })], pagination: { next_uri: null } };
      }
      return { data: [v2Account({ id: "v2-1" })], pagination: { next_uri: "/v2/accounts?starting_after=A" } };
    });
    const result = await fetchV2Accounts({ fetchJson, ...COMMON });
    expect(calls).toHaveLength(2);
    expect(String(calls[1]!.url)).toBe("https://api.coinbase.com/v2/accounts?starting_after=A");
    expect(result.map((a) => a.id)).toEqual(["v2-1", "v2-2"]);
  });

  test("mints a fresh JWT for each page with the page-specific path", async () => {
    const recorded: Array<{ method: string; path: string }> = [];
    const tracingBuildJwt = async (args: { method: string; host: string; path: string }) => {
      recorded.push({ method: args.method, path: args.path });
      return FIXED_JWT;
    };
    const { fetchJson } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.includes("starting_after=A")) {
        return { data: [], pagination: { next_uri: null } };
      }
      return { data: [], pagination: { next_uri: "/v2/accounts?starting_after=A" } };
    });
    await fetchV2Accounts({
      fetchJson,
      baseUrl: "https://api.coinbase.com",
      buildJwt: tracingBuildJwt,
      userAgent: USER_AGENT,
    });
    expect(recorded).toEqual([
      { method: "GET", path: "/v2/accounts" },
      { method: "GET", path: "/v2/accounts" }, // path stripped of query string
    ]);
  });

  test("treats missing pagination as a stop signal", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({ data: [v2Account()] }));
    const result = await fetchV2Accounts({ fetchJson, ...COMMON });
    expect(calls).toHaveLength(1);
    expect(result).toHaveLength(1);
  });
});

describe("fetchV2Transactions — single page", () => {
  test("URL targets /v2/accounts/{uuid}/transactions?limit=100", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({
      data: [v2Txn()],
      pagination: { next_uri: null },
    }));
    const result = await fetchV2Transactions({ fetchJson, ...COMMON, accountId: "abc-uuid" });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.url)).toBe(
      "https://api.coinbase.com/v2/accounts/abc-uuid/transactions?limit=100",
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("txn-1");
  });
});

describe("fetchV2Transactions — next_uri pagination", () => {
  test("follows next_uri to gather all txns", async () => {
    const { fetchJson, calls } = stubFetchJson((call) => {
      const url = String(call.url);
      if (url.endsWith("starting_after=Z")) {
        return { data: [v2Txn({ id: "txn-2" })], pagination: { next_uri: null } };
      }
      return {
        data: [v2Txn({ id: "txn-1" })],
        pagination: { next_uri: "/v2/accounts/abc-uuid/transactions?starting_after=Z" },
      };
    });
    const result = await fetchV2Transactions({ fetchJson, ...COMMON, accountId: "abc-uuid" });
    expect(calls).toHaveLength(2);
    expect(result.map((t) => t.id)).toEqual(["txn-1", "txn-2"]);
  });
});
