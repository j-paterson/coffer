import type { FetchJson } from "../../types/http";

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

export interface JsonRpcClientOpts {
  url: string;
  fetchJson: FetchJson;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcClient {
  call<R>(method: string, params: unknown): Promise<R>;
  batch(calls: Array<{ method: string; params: unknown }>): Promise<unknown[]>;
}

export function makeJsonRpc(opts: JsonRpcClientOpts): JsonRpcClient {
  const { url, fetchJson } = opts;

  async function send(body: JsonRpcRequest | JsonRpcRequest[]): Promise<JsonRpcResponse | JsonRpcResponse[]> {
    return fetchJson<JsonRpcResponse | JsonRpcResponse[]>(url, {
      method: "POST",
      body,
    });
  }

  return {
    async call<R>(method: string, params: unknown): Promise<R> {
      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params,
      };
      const res = (await send(req)) as JsonRpcResponse;
      if (res.error !== undefined) {
        throw new JsonRpcError(res.error.code, res.error.message, res.error.data);
      }
      return res.result as R;
    },

    async batch(calls): Promise<unknown[]> {
      if (calls.length === 0) return [];
      const reqs: JsonRpcRequest[] = calls.map((c) => ({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: c.method,
        params: c.params,
      }));
      const res = (await send(reqs)) as JsonRpcResponse[];
      const byId = new Map<string, JsonRpcResponse>();
      for (const r of res) byId.set(r.id, r);
      const out: unknown[] = [];
      for (const req of reqs) {
        const r = byId.get(req.id);
        if (r === undefined) {
          throw new Error(`jsonrpc: missing response for request id ${req.id}`);
        }
        if (r.error !== undefined) {
          throw new JsonRpcError(r.error.code, r.error.message, r.error.data);
        }
        out.push(r.result);
      }
      return out;
    },
  };
}
