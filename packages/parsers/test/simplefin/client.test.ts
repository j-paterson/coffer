import { describe, expect, test } from "bun:test";
import { splitAccessUrl, USER_AGENT } from "../../src/simplefin/client";
import { fetchAccountsWindow } from "../../src/simplefin/client";
import type { FetchJson, FetchJsonOpts } from "../../src/types/http";

describe("splitAccessUrl", () => {
  test("extracts basic-auth and strips it from the URL", () => {
    const out = splitAccessUrl("https://user:pass@host.example/simplefin");
    expect(out.baseUrl).toBe("https://host.example/simplefin");
    // base64("user:pass") = "dXNlcjpwYXNz"
    expect(out.basicAuthHeader).toBe("Basic dXNlcjpwYXNz");
  });

  test("handles percent-encoded credentials", () => {
    // base64("u@s:er:p@ss") = "dUBzOmVyOnBAc3M="
    const out = splitAccessUrl("https://u%40s%3Aer:p%40ss@host.example/simplefin");
    expect(out.baseUrl).toBe("https://host.example/simplefin");
    expect(out.basicAuthHeader).toBe("Basic dUBzOmVyOnBAc3M=");
  });

  test("preserves trailing path but drops trailing slash from baseUrl", () => {
    const out = splitAccessUrl("https://u:p@host.example/simplefin/");
    expect(out.baseUrl).toBe("https://host.example/simplefin");
  });

  test("throws when the URL has no embedded credentials", () => {
    expect(() => splitAccessUrl("https://host.example/simplefin")).toThrow(/basic[- ]auth/i);
  });

  test("throws when the URL is malformed", () => {
    expect(() => splitAccessUrl("not a url")).toThrow();
  });
});

describe("USER_AGENT", () => {
  test("is the canonical finance-parsers value", () => {
    expect(USER_AGENT).toBe("finance-parsers/simplefin");
  });
});

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

describe("fetchAccountsWindow", () => {
  test("composes the URL with start-date, end-date, pending=0", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({ accounts: [], errlist: [] }));
    await fetchAccountsWindow({
      fetchJson,
      baseUrl: "https://host.example/simplefin",
      basicAuthHeader: "Basic xxx",
      startUnix: 1700000000,
      endUnix:   1700864000,
      includePending: false,
      userAgent: "finance-parsers/test",
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.url)).toBe(
      "https://host.example/simplefin/accounts?start-date=1700000000&end-date=1700864000&pending=0",
    );
  });

  test("encodes pending=1 when includePending is true", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({ accounts: [], errlist: [] }));
    await fetchAccountsWindow({
      fetchJson,
      baseUrl: "https://host.example/simplefin",
      basicAuthHeader: "Basic xxx",
      startUnix: 1700000000,
      endUnix:   1700864000,
      includePending: true,
      userAgent: "finance-parsers/test",
    });
    expect(String(calls[0]!.url)).toBe(
      "https://host.example/simplefin/accounts?start-date=1700000000&end-date=1700864000&pending=1",
    );
  });

  test("sets Authorization, User-Agent, Accept, and method=GET", async () => {
    const { fetchJson, calls } = stubFetchJson(() => ({ accounts: [], errlist: [] }));
    await fetchAccountsWindow({
      fetchJson,
      baseUrl: "https://host.example/simplefin",
      basicAuthHeader: "Basic dXNlcjpwYXNz",
      startUnix: 1, endUnix: 2,
      includePending: false,
      userAgent: "finance-parsers/simplefin",
    });
    const opts = calls[0]!.opts!;
    expect(opts.method).toBe("GET");
    expect(opts.headers?.Authorization).toBe("Basic dXNlcjpwYXNz");
    expect(opts.headers?.["User-Agent"]).toBe("finance-parsers/simplefin");
    expect(opts.headers?.Accept).toBe("application/json");
  });

  test("returns the parsed response body unchanged", async () => {
    const body = {
      accounts: [
        { id: "a1", name: "Checking", currency: "USD", balance: "100.00", transactions: [] },
      ],
      errlist: ["one error"],
    };
    const { fetchJson } = stubFetchJson(() => body);
    const out = await fetchAccountsWindow({
      fetchJson,
      baseUrl: "https://host.example/simplefin",
      basicAuthHeader: "Basic xxx",
      startUnix: 1, endUnix: 2,
      includePending: false,
      userAgent: "finance-parsers/test",
    });
    expect(out).toEqual(body);
  });
});
