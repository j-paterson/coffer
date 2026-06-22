import { describe, expect, test } from "bun:test";
import {
  HttpNetworkError,
  HttpStatusError,
  ParserHttpError,
} from "../../src/http/errors";

describe("HttpStatusError", () => {
  test("carries kind, status, bodyExcerpt, url, method, attempts", () => {
    const err = new HttpStatusError("boom", {
      url: "https://example.test/x",
      method: "GET",
      attempts: 3,
      status: 503,
      bodyExcerpt: "service unavailable",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ParserHttpError);
    expect(err).toBeInstanceOf(HttpStatusError);
    expect(err.kind).toBe("status");
    expect(err.name).toBe("HttpStatusError");
    expect(err.message).toBe("boom");
    expect(err.url).toBe("https://example.test/x");
    expect(err.method).toBe("GET");
    expect(err.attempts).toBe(3);
    expect(err.status).toBe(503);
    expect(err.bodyExcerpt).toBe("service unavailable");
  });
});

describe("HttpNetworkError", () => {
  test("carries kind, cause, url, method, attempts", () => {
    const cause = new TypeError("fetch failed");
    const err = new HttpNetworkError("network down", {
      url: "https://example.test/y",
      method: "POST",
      attempts: 4,
      cause,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ParserHttpError);
    expect(err).toBeInstanceOf(HttpNetworkError);
    expect(err.kind).toBe("network");
    expect(err.name).toBe("HttpNetworkError");
    expect(err.url).toBe("https://example.test/y");
    expect(err.method).toBe("POST");
    expect(err.cause).toBe(cause);
    expect(err.attempts).toBe(4);
  });

  test("kind discriminant narrows union types", () => {
    const errs: ParserHttpError[] = [
      new HttpStatusError("a", { url: "u", method: "GET", attempts: 1, status: 500, bodyExcerpt: "" }),
      new HttpNetworkError("b", { url: "u", method: "GET", attempts: 1, cause: null }),
    ];
    const kinds = errs.map((e) => e.kind);
    expect(kinds).toEqual(["status", "network"]);
  });
});
