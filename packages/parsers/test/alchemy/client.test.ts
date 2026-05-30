import { describe, expect, test } from "bun:test";
import {
  makeAlchemyRpc,
  getNativeBalance,
  getTokenBalances,
  getTokenMetadata,
} from "../../src/alchemy/client";
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

interface JsonRpcBody {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: unknown;
}

function rpcReply(captured: Captured, result: unknown): unknown {
  const body = captured.opts!.body as JsonRpcBody;
  return { jsonrpc: "2.0", id: body.id, result };
}

describe("makeAlchemyRpc", () => {
  test("uses the chain's URL slug + api key in the URL path", async () => {
    const { fetchJson, calls } = stubFetchJson((c) => rpcReply(c, "0x0"));
    const rpc = makeAlchemyRpc({ fetchJson, chain: "ethereum", apiKey: "key-xyz" });
    await rpc.call("eth_getBalance", ["0xa", "latest"]);
    expect(String(calls[0]!.url)).toBe("https://eth-mainnet.g.alchemy.com/v2/key-xyz");
  });

  test("each chain gets its own URL", async () => {
    const { fetchJson, calls } = stubFetchJson((c) => rpcReply(c, "0x0"));
    await makeAlchemyRpc({ fetchJson, chain: "base", apiKey: "k" }).call("eth_getBalance", ["0xa", "latest"]);
    await makeAlchemyRpc({ fetchJson, chain: "polygon", apiKey: "k" }).call("eth_getBalance", ["0xa", "latest"]);
    expect(String(calls[0]!.url)).toBe("https://base-mainnet.g.alchemy.com/v2/k");
    expect(String(calls[1]!.url)).toBe("https://polygon-mainnet.g.alchemy.com/v2/k");
  });
});

describe("getNativeBalance", () => {
  test("calls eth_getBalance with lowercased address + 'latest'", async () => {
    const { fetchJson, calls } = stubFetchJson((c) => rpcReply(c, "0x16345785d8a0000"));
    const rpc = makeAlchemyRpc({ fetchJson, chain: "ethereum", apiKey: "k" });
    const result = await getNativeBalance(rpc, "0xABCDEF0123456789ABCDEF0123456789ABCDEF01");
    const body = calls[0]!.opts!.body as JsonRpcBody;
    expect(body.method).toBe("eth_getBalance");
    expect(body.params).toEqual([
      "0xabcdef0123456789abcdef0123456789abcdef01",
      "latest",
    ]);
    expect(result).toBe("0x16345785d8a0000");
  });

  test("propagates JsonRpcError on upstream error", async () => {
    const { fetchJson } = stubFetchJson((c) => {
      const body = c.opts!.body as JsonRpcBody;
      return { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "boom" } };
    });
    const rpc = makeAlchemyRpc({ fetchJson, chain: "ethereum", apiKey: "k" });
    await expect(getNativeBalance(rpc, "0xa")).rejects.toThrow(/boom/);
  });
});

describe("getTokenBalances", () => {
  test("calls alchemy_getTokenBalances with [address] (lowercased)", async () => {
    const { fetchJson, calls } = stubFetchJson((c) =>
      rpcReply(c, { tokenBalances: [] }),
    );
    const rpc = makeAlchemyRpc({ fetchJson, chain: "ethereum", apiKey: "k" });
    await getTokenBalances(rpc, "0xABCDEF0123456789ABCDEF0123456789ABCDEF01");
    const body = calls[0]!.opts!.body as JsonRpcBody;
    expect(body.method).toBe("alchemy_getTokenBalances");
    expect(body.params).toEqual(["0xabcdef0123456789abcdef0123456789abcdef01"]);
  });

  test("returns the tokenBalances array verbatim", async () => {
    const { fetchJson } = stubFetchJson((c) =>
      rpcReply(c, {
        address: "0xa",
        tokenBalances: [
          { contractAddress: "0xUSDC", tokenBalance: "0x3b9aca00" },
          { contractAddress: "0xWETH", tokenBalance: "0x0" },
        ],
      }),
    );
    const rpc = makeAlchemyRpc({ fetchJson, chain: "ethereum", apiKey: "k" });
    const result = await getTokenBalances(rpc, "0xa");
    expect(result.tokenBalances).toHaveLength(2);
    expect(result.tokenBalances![0]!.contractAddress).toBe("0xUSDC");
    expect(result.tokenBalances![0]!.tokenBalance).toBe("0x3b9aca00");
  });

  test("propagates JsonRpcError on upstream error", async () => {
    const { fetchJson } = stubFetchJson((c) => {
      const body = c.opts!.body as JsonRpcBody;
      return { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "rate limited" } };
    });
    const rpc = makeAlchemyRpc({ fetchJson, chain: "ethereum", apiKey: "k" });
    await expect(getTokenBalances(rpc, "0xa")).rejects.toThrow(/rate limited/);
  });
});

describe("getTokenMetadata", () => {
  test("calls alchemy_getTokenMetadata with [contract] (lowercased)", async () => {
    const { fetchJson, calls } = stubFetchJson((c) =>
      rpcReply(c, { name: "USD Coin", symbol: "USDC", decimals: 6, logo: null }),
    );
    const rpc = makeAlchemyRpc({ fetchJson, chain: "ethereum", apiKey: "k" });
    await getTokenMetadata(rpc, "0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48");
    const body = calls[0]!.opts!.body as JsonRpcBody;
    expect(body.method).toBe("alchemy_getTokenMetadata");
    expect(body.params).toEqual(["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"]);
  });

  test("returns the metadata object verbatim", async () => {
    const fixture = { name: "USD Coin", symbol: "USDC", decimals: 6, logo: null };
    const { fetchJson } = stubFetchJson((c) => rpcReply(c, fixture));
    const rpc = makeAlchemyRpc({ fetchJson, chain: "ethereum", apiKey: "k" });
    const result = await getTokenMetadata(rpc, "0xa");
    expect(result).toEqual(fixture);
  });

  test("propagates JsonRpcError on upstream error", async () => {
    const { fetchJson } = stubFetchJson((c) => {
      const body = c.opts!.body as JsonRpcBody;
      return { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "not a token" } };
    });
    const rpc = makeAlchemyRpc({ fetchJson, chain: "ethereum", apiKey: "k" });
    await expect(getTokenMetadata(rpc, "0xa")).rejects.toThrow(/not a token/);
  });
});
