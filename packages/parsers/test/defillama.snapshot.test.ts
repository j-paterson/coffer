import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Operation } from "@coffer/ledger/runner";
import { defiLlamaParser } from "../src/defillama";
import { DefiLlamaConfig } from "../src/defillama/config";
import { buildContext } from "../src/context";
import { ConsoleLogger } from "../src/types/logger";
import type { FetchJson, FetchJsonOpts } from "../src/types/http";

const SILENT_SINK = { debug() {}, info() {}, warn() {}, error() {} };
const FIXTURE = resolve(import.meta.dir, "fixtures/defillama/single-chunk.json");

describe("defiLlamaParser snapshot", () => {
  test("public surface is stable", () => {
    expect(defiLlamaParser.id).toBe("defillama");
    expect(defiLlamaParser.name).toBe("DefiLlama");
    expect(defiLlamaParser.capabilities).toEqual(["prices"]);
    expect(defiLlamaParser.configSchema).toBe(DefiLlamaConfig);
  });

  test("emits the expected op stream for the single-chunk fixture", async () => {
    const cfg = DefiLlamaConfig.parse({
      targets: [{ symbol: "ETH", since: "2023-11-14" }],
    });
    const fixture = JSON.parse(await Bun.file(FIXTURE).text());
    const fetchJson: FetchJson = async <T>(_url: string | URL, _opts?: FetchJsonOpts): Promise<T> =>
      fixture as T;

    const ctx = buildContext({
      config: cfg,
      logger: new ConsoleLogger(SILENT_SINK),
      // NOTE: bound endUnix tightly — see Task 8 epoch-math correction.
      // nextStart after fixture's last point (1700172800 + 86400) = 1700259200.
      // Setting now to this exact value makes nextStart === endUnix → walker
      // halts after one call → snapshot contains exactly 3 ops.
      now: () => new Date(1700259200 * 1000),
    });
    (ctx as { fetchJson: FetchJson }).fetchJson = fetchJson;

    const ops: Operation[] = [];
    for await (const op of defiLlamaParser.sync(ctx)) ops.push(op);

    expect(ops).toMatchSnapshot();
  });
});
