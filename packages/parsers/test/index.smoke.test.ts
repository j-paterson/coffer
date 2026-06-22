import { describe, expect, test } from "bun:test";
import {
  buildContext,
  DEFAULT_RETRY,
  EnvSecretResolver,
  HttpNetworkError,
  HttpStatusError,
  InMemoryParserCache,
  paginate,
  ParserHttpError,
  simpleFinParser,
  SimpleFinConfig,
  SqliteParserCache,
  type FetchJson,
  type PageAdapter,
  type SecretResolver,
  type SimpleFinConfigType,
} from "../src";

describe("public index exports", () => {
  test("all expected runtime exports exist", () => {
    expect(typeof buildContext).toBe("function");
    expect(typeof paginate).toBe("function");
    expect(DEFAULT_RETRY.maxAttempts).toBe(4);
    expect(InMemoryParserCache).toBeDefined();
    expect(SqliteParserCache).toBeDefined();
    expect(EnvSecretResolver).toBeDefined();
    expect(ParserHttpError).toBeDefined();
    expect(HttpStatusError).toBeDefined();
    expect(HttpNetworkError).toBeDefined();
    expect(simpleFinParser.id).toBe("simplefin");
    expect(SimpleFinConfig.parse({}).lookback_days).toBe(90);
  });

  test("type aliases are importable (compile-time)", () => {
    // Compile-only: just assert the types resolve.
    const _fj: FetchJson | null = null;
    const _adapter: PageAdapter<number, string> | null = null;
    const _sec: SecretResolver | null = null;
    const _sfc: SimpleFinConfigType | null = null;
    void _fj;
    void _adapter;
    void _sec;
    void _sfc;
  });

  test("buildContext returns a context whose fetchJson works against the new surface", async () => {
    const ctx = buildContext({ config: {} });
    expect(typeof ctx.fetchJson).toBe("function");
  });
});
