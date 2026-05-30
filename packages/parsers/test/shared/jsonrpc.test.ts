import { describe, expect, test } from "bun:test";
import type { FetchJson, FetchJsonOpts } from "../../src/types/http";
import { JsonRpcError, makeJsonRpc } from "../../src/shared/jsonrpc/client";

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

describe("makeJsonRpc.call", () => {
  test("sends a JSON-RPC 2.0 envelope and returns result on success", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({
      jsonrpc: "2.0",
      id: "test-id",
      result: { block: 18000000 },
    }));
    const rpc = makeJsonRpc({ url: "https://rpc.example/x", fetchJson });
    const out = await rpc.call<{ block: number }>("eth_blockNumber", []);
    expect(out).toEqual({ block: 18000000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://rpc.example/x");
    expect(calls[0]!.opts?.method).toBe("POST");
    const body = calls[0]!.opts?.body as { jsonrpc: string; method: string; params: unknown; id: string };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("eth_blockNumber");
    expect(body.params).toEqual([]);
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
  });

  test("throws JsonRpcError when the response carries an error envelope", async () => {
    const { fetchJson } = stubFetchJson(() => ({
      jsonrpc: "2.0",
      id: "test-id",
      error: { code: -32601, message: "Method not found", data: { method: "foo" } },
    }));
    const rpc = makeJsonRpc({ url: "https://rpc.example/x", fetchJson });
    let caught: unknown;
    try {
      await rpc.call("foo", []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JsonRpcError);
    expect((caught as JsonRpcError).code).toBe(-32601);
    expect((caught as JsonRpcError).message).toBe("Method not found");
    expect((caught as JsonRpcError).data).toEqual({ method: "foo" });
  });

  test("HTTP-level errors from fetchJson propagate unchanged", async () => {
    const httpErr = new Error("HTTP 502 Bad Gateway");
    const fetchJson: FetchJson = async () => {
      throw httpErr;
    };
    const rpc = makeJsonRpc({ url: "https://rpc.example/x", fetchJson });
    let caught: unknown;
    try {
      await rpc.call("eth_blockNumber", []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(httpErr);
  });
});

describe("makeJsonRpc.batch", () => {
  test("sends an array request and returns results in input order", async () => {
    const { fetchJson, calls } = stubFetchJson((c) => {
      const req = c.opts?.body as Array<{ id: string; method: string }>;
      return req.map((r) => ({
        jsonrpc: "2.0",
        id: r.id,
        result: r.method === "eth_blockNumber" ? "0x1" : "0x2",
      }));
    });
    const rpc = makeJsonRpc({ url: "https://rpc.example/x", fetchJson });
    const out = await rpc.batch([
      { method: "eth_blockNumber", params: [] },
      { method: "eth_chainId", params: [] },
    ]);
    expect(out).toEqual(["0x1", "0x2"]);
    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0]!.opts?.body)).toBe(true);
    expect((calls[0]!.opts?.body as unknown[]).length).toBe(2);
  });

  test("re-orders out-of-order responses by id back to input order", async () => {
    const { fetchJson } = stubFetchJson((c) => {
      const req = c.opts?.body as Array<{ id: string; method: string }>;
      // Return responses in reverse order.
      return [
        { jsonrpc: "2.0", id: req[1]!.id, result: "second" },
        { jsonrpc: "2.0", id: req[0]!.id, result: "first" },
      ];
    });
    const rpc = makeJsonRpc({ url: "https://rpc.example/x", fetchJson });
    const out = await rpc.batch([
      { method: "a", params: [] },
      { method: "b", params: [] },
    ]);
    expect(out).toEqual(["first", "second"]);
  });

  test("throws JsonRpcError on the first error in a partial-failure batch", async () => {
    const { fetchJson } = stubFetchJson((c) => {
      const req = c.opts?.body as Array<{ id: string; method: string }>;
      return [
        { jsonrpc: "2.0", id: req[0]!.id, result: "ok" },
        {
          jsonrpc: "2.0",
          id: req[1]!.id,
          error: { code: -32000, message: "Reverted", data: { txHash: "0xabc" } },
        },
      ];
    });
    const rpc = makeJsonRpc({ url: "https://rpc.example/x", fetchJson });
    let caught: unknown;
    try {
      await rpc.batch([
        { method: "a", params: [] },
        { method: "b", params: [] },
      ]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(JsonRpcError);
    expect((caught as JsonRpcError).code).toBe(-32000);
    expect((caught as JsonRpcError).message).toBe("Reverted");
    expect((caught as JsonRpcError).data).toEqual({ txHash: "0xabc" });
  });

  test("throws when the response is missing an entry for one of the request ids", async () => {
    const { fetchJson } = stubFetchJson((c) => {
      const req = c.opts?.body as Array<{ id: string }>;
      return [{ jsonrpc: "2.0", id: req[0]!.id, result: "ok" }];
    });
    const rpc = makeJsonRpc({ url: "https://rpc.example/x", fetchJson });
    let caught: unknown;
    try {
      await rpc.batch([
        { method: "a", params: [] },
        { method: "b", params: [] },
      ]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/missing response/i);
  });

  test("empty batch returns empty array without calling fetchJson", async () => {
    const { fetchJson, calls } = stubFetchJson(() => {
      throw new Error("should not be called");
    });
    const rpc = makeJsonRpc({ url: "https://rpc.example/x", fetchJson });
    const out = await rpc.batch([]);
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
