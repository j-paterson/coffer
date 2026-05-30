import { describe, expect, test, mock } from "bun:test";
import { makeFetchJson } from "../../src/http/fetch-json";
import {
  HttpNetworkError,
  HttpStatusError,
} from "../../src/http/errors";
import { DEFAULT_RETRY } from "../../src/types/http";

const SILENT_LOGGER = {
  debug() {}, info() {}, warn() {}, error() {},
};

function queuedFetch(responses: Array<Response | Error>): typeof fetch {
  let i = 0;
  return (async (_input: unknown, _init?: unknown) => {
    const next = responses[i++];
    if (next === undefined) throw new Error(`fetch called more than ${responses.length} times`);
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
}

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("fetchJson", () => {
  test("returns parsed JSON on 200", async () => {
    const fj = makeFetchJson(
      queuedFetch([jsonRes({ ok: true, n: 1 })]),
      SILENT_LOGGER,
      DEFAULT_RETRY,
      async () => {},
    );
    const out = await fj<{ ok: boolean; n: number }>("https://a.test/x");
    expect(out).toEqual({ ok: true, n: 1 });
  });

  test("retries on 429 then succeeds", async () => {
    const fj = makeFetchJson(
      queuedFetch([
        new Response("rate limited", { status: 429 }),
        jsonRes({ ok: true }),
      ]),
      SILENT_LOGGER,
      DEFAULT_RETRY,
      async () => {},
      () => 0,
    );
    const out = await fj<{ ok: boolean }>("https://a.test/x");
    expect(out).toEqual({ ok: true });
  });

  test("retries on 500 then succeeds", async () => {
    const fj = makeFetchJson(
      queuedFetch([
        new Response("oops", { status: 500 }),
        jsonRes({ ok: true }),
      ]),
      SILENT_LOGGER,
      DEFAULT_RETRY,
      async () => {},
      () => 0,
    );
    const out = await fj<{ ok: boolean }>("https://a.test/x");
    expect(out).toEqual({ ok: true });
  });

  test("does not retry on 400 — throws HttpStatusError immediately", async () => {
    const f = mock(queuedFetch([new Response("bad", { status: 400 })]));
    const fj = makeFetchJson(f, SILENT_LOGGER, DEFAULT_RETRY, async () => {});
    let caught: unknown;
    try {
      await fj("https://a.test/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpStatusError);
    expect((caught as HttpStatusError).status).toBe(400);
    expect((caught as HttpStatusError).attempts).toBe(1);
    expect(f).toHaveBeenCalledTimes(1);
  });

  test("network failure: retries then throws HttpNetworkError after maxAttempts", async () => {
    const fj = makeFetchJson(
      queuedFetch([
        new TypeError("dns boom"),
        new TypeError("dns boom"),
        new TypeError("dns boom"),
        new TypeError("dns boom"),
      ]),
      SILENT_LOGGER,
      DEFAULT_RETRY,
      async () => {},
      () => 0,
    );
    let caught: unknown;
    try {
      await fj("https://a.test/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpNetworkError);
    expect((caught as HttpNetworkError).attempts).toBe(4);
  });

  test("honors Retry-After header", async () => {
    const sleeps: number[] = [];
    const fj = makeFetchJson(
      queuedFetch([
        new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
        jsonRes({ ok: true }),
      ]),
      SILENT_LOGGER,
      DEFAULT_RETRY,
      async (ms) => {
        sleeps.push(ms);
      },
      () => 0,
    );
    await fj("https://a.test/x");
    expect(sleeps).toEqual([2000]);
  });

  test("retries: 0 disables retries", async () => {
    const f = mock(queuedFetch([new Response("oops", { status: 500 })]));
    const fj = makeFetchJson(f, SILENT_LOGGER, DEFAULT_RETRY, async () => {});
    let caught: unknown;
    try {
      await fj("https://a.test/x", { retries: 0 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpStatusError);
    expect((caught as HttpStatusError).attempts).toBe(1);
    expect(f).toHaveBeenCalledTimes(1);
  });

  test("acceptStatus override accepts 404", async () => {
    const fj = makeFetchJson(
      queuedFetch([new Response(JSON.stringify({ found: false }), { status: 404 })]),
      SILENT_LOGGER,
      DEFAULT_RETRY,
      async () => {},
    );
    const out = await fj<{ found: boolean }>("https://a.test/x", {
      acceptStatus: [200, 404],
    });
    expect(out).toEqual({ found: false });
  });

  test("POST body is JSON-stringified with content-type default", async () => {
    let captured: { method?: string; body?: unknown; headers?: Headers } = {};
    const fakeFetch = (async (_url: unknown, init: RequestInit) => {
      captured = {
        method: init.method,
        body: init.body,
        headers: new Headers(init.headers as HeadersInit),
      };
      return jsonRes({ ok: true });
    }) as unknown as typeof fetch;
    const fj = makeFetchJson(fakeFetch, SILENT_LOGGER, DEFAULT_RETRY, async () => {});
    await fj("https://a.test/x", { method: "POST", body: { foo: 1 } });
    expect(captured.method).toBe("POST");
    expect(captured.body).toBe('{"foo":1}');
    expect(captured.headers?.get("content-type")).toBe("application/json");
  });

  test("string body is passed through without content-type defaulting", async () => {
    let capturedBody: unknown;
    let capturedCT: string | null = null;
    const fakeFetch = (async (_url: unknown, init: RequestInit) => {
      capturedBody = init.body;
      capturedCT = new Headers(init.headers as HeadersInit).get("content-type");
      return jsonRes({ ok: true });
    }) as unknown as typeof fetch;
    const fj = makeFetchJson(fakeFetch, SILENT_LOGGER, DEFAULT_RETRY, async () => {});
    await fj("https://a.test/x", { method: "POST", body: "raw=1" });
    expect(capturedBody).toBe("raw=1");
    expect(capturedCT).toBeNull();
  });
});
