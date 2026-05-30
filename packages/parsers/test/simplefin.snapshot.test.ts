import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Operation } from "@coffer/ledger/runner";
import { simpleFinParser } from "../src/simplefin";
import { SimpleFinConfig } from "../src/simplefin/config";
import { buildContext } from "../src/context";
import { ConsoleLogger } from "../src/types/logger";
import type { FetchJson, FetchJsonOpts } from "../src/types/http";
import type { SecretResolver } from "../src/types/secrets";

const SILENT_SINK = { debug() {}, info() {}, warn() {}, error() {} };
const FIXTURE = resolve(import.meta.dir, "fixtures/simplefin/single-window.json");

function staticSecrets(map: Record<string, string | null>): SecretResolver {
  return { async get(name) { return map[name] ?? null; } };
}

describe("simpleFinParser snapshot", () => {
  test("emits the expected op stream for the single-window fixture", async () => {
    const cfg = SimpleFinConfig.parse({ lookback_days: 30 });
    const fixture = JSON.parse(await Bun.file(FIXTURE).text());
    const fetchJson: FetchJson = async <T>(_url: string | URL, _opts?: FetchJsonOpts): Promise<T> => fixture as T;

    const ctx = buildContext({
      config: cfg,
      logger: new ConsoleLogger(SILENT_SINK),
      secrets: staticSecrets({ SIMPLEFIN_ACCESS_URL: "https://u:p@host.example/simplefin" }),
      now: () => new Date("2026-05-01T00:00:00Z"),
    });
    (ctx as { fetchJson: FetchJson }).fetchJson = fetchJson;

    const ops: Operation[] = [];
    for await (const op of simpleFinParser.sync(ctx)) ops.push(op);

    expect(ops).toMatchSnapshot();
  });
});
