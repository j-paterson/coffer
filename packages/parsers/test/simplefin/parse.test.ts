import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { syncSimpleFin } from "../../src/simplefin/parse";
import { SimpleFinConfig } from "../../src/simplefin/config";
import { buildContext } from "../../src/context";
import { ConsoleLogger } from "../../src/types/logger";
import type { Operation } from "@coffer/ledger/runner";
import type { FetchJson, FetchJsonOpts } from "../../src/types/http";
import type { SecretResolver } from "../../src/types/secrets";

const SILENT_SINK = { debug() {}, info() {}, warn() {}, error() {} };
const FIXTURE_SINGLE = resolve(import.meta.dir, "../fixtures/simplefin/single-window.json");
const FIXTURE_A      = resolve(import.meta.dir, "../fixtures/simplefin/multi-window-a.json");
const FIXTURE_B      = resolve(import.meta.dir, "../fixtures/simplefin/multi-window-b.json");

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

function staticSecrets(map: Record<string, string | null>): SecretResolver {
  return { async get(name) { return map[name] ?? null; } };
}

async function collect(gen: AsyncIterable<Operation>): Promise<Operation[]> {
  const out: Operation[] = [];
  for await (const op of gen) out.push(op);
  return out;
}

describe("syncSimpleFin", () => {
  test("missing access URL env → emits one sync_warning, no fetch attempted", async () => {
    const cfg = SimpleFinConfig.parse({});
    const { fetchJson, calls } = stubFetchJson(() => {
      throw new Error("should not be called");
    });
    const ctx = buildContext({
      config: cfg,
      logger: new ConsoleLogger(SILENT_SINK),
      secrets: staticSecrets({}),  // SIMPLEFIN_ACCESS_URL absent
      now: () => new Date("2026-05-01T00:00:00Z"),
    });
    // buildContext built fetchJson from globalThis.fetch; override for the test.
    (ctx as { fetchJson: FetchJson }).fetchJson = fetchJson;

    const ops = await collect(syncSimpleFin(ctx));
    expect(calls).toHaveLength(0);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("sync_warning");
    expect((ops[0] as { warning: { scope: string | null; message: string } }).warning.scope).toBe("config");
    expect((ops[0] as { warning: { scope: string | null; message: string } }).warning.message).toContain("SIMPLEFIN_ACCESS_URL");
  });

  test("malformed access URL (no auth) → sync_warning, no fetch attempted", async () => {
    const cfg = SimpleFinConfig.parse({});
    const { fetchJson, calls } = stubFetchJson(() => {
      throw new Error("should not be called");
    });
    const ctx = buildContext({
      config: cfg,
      logger: new ConsoleLogger(SILENT_SINK),
      secrets: staticSecrets({ SIMPLEFIN_ACCESS_URL: "https://host.example/simplefin" }),
      now: () => new Date("2026-05-01T00:00:00Z"),
    });
    (ctx as { fetchJson: FetchJson }).fetchJson = fetchJson;

    const ops = await collect(syncSimpleFin(ctx));
    expect(calls).toHaveLength(0);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("sync_warning");
    expect((ops[0] as { warning: { message: string } }).warning.message.toLowerCase()).toContain("malformed");
  });

  test("single-window happy path: fixture → expected op stream", async () => {
    const cfg = SimpleFinConfig.parse({ lookback_days: 30 });
    const fixture = JSON.parse(await Bun.file(FIXTURE_SINGLE).text());
    const { fetchJson, calls } = stubFetchJson(() => fixture);
    const ctx = buildContext({
      config: cfg,
      logger: new ConsoleLogger(SILENT_SINK),
      secrets: staticSecrets({ SIMPLEFIN_ACCESS_URL: "https://u:p@host.example/simplefin" }),
      now: () => new Date("2026-05-01T00:00:00Z"),
    });
    (ctx as { fetchJson: FetchJson }).fetchJson = fetchJson;

    const ops = await collect(syncSimpleFin(ctx));

    // Exactly one HTTP call (lookback < 90 days = single window).
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.url)).toContain("https://host.example/simplefin/accounts");
    expect(calls[0]!.opts?.headers?.Authorization).toBe("Basic dTpw");

    // 3 accounts × (account_discovery + balance raw_event + assertion) = 9 baseline ops
    // + 6 txns × 2 = 12
    // + 2 holdings × 2 = 4
    // + 1 errlist warning
    // = 26 ops
    expect(ops).toHaveLength(26);
    expect(ops.filter((o) => o.kind === "account_discovery")).toHaveLength(3);
    expect(ops.filter((o) => o.kind === "assertion")).toHaveLength(3);
    expect(ops.filter((o) => o.kind === "one_sided")).toHaveLength(6);
    expect(ops.filter((o) => o.kind === "position_snapshot")).toHaveLength(2);
    expect(ops.filter((o) => o.kind === "sync_warning")).toHaveLength(1);
  });

  test("multi-window pagination: lookback_days 200 → 3 fetch calls, oldest-first order", async () => {
    const cfg = SimpleFinConfig.parse({ lookback_days: 200 });
    const fixA = JSON.parse(await Bun.file(FIXTURE_A).text());
    const fixB = JSON.parse(await Bun.file(FIXTURE_B).text());
    const empty = { accounts: [], errlist: [] };
    let callIdx = 0;
    const responses = [fixA, empty, fixB];  // 3 windows; middle one empty
    const { fetchJson, calls } = stubFetchJson(() => responses[callIdx++]);
    const ctx = buildContext({
      config: cfg,
      logger: new ConsoleLogger(SILENT_SINK),
      secrets: staticSecrets({ SIMPLEFIN_ACCESS_URL: "https://u:p@host.example/simplefin" }),
      now: () => new Date("2026-05-01T00:00:00Z"),
    });
    (ctx as { fetchJson: FetchJson }).fetchJson = fetchJson;

    const ops = await collect(syncSimpleFin(ctx));

    expect(calls).toHaveLength(3);  // ceil(200/90) = 3 windows

    // Verify the windows are oldest-first by inspecting start-date params.
    const startDates = calls.map((c) => {
      const u = new URL(String(c.url));
      return Number(u.searchParams.get("start-date"));
    });
    expect(startDates[0]).toBeLessThan(startDates[1]!);
    expect(startDates[1]).toBeLessThan(startDates[2]!);

    // Merge result: chk-001 (newer name + balance from fixB), stale-acct (only in fixA, still emitted).
    const disc = ops.filter((o) => o.kind === "account_discovery");
    expect(disc).toHaveLength(2);
    const ids = disc.map((o) => (o.draft as { id: string }).id).sort();
    expect(ids).toEqual(["simplefin:chk-001", "simplefin:stale-acct"]);
    const chk = disc.find((o) => (o.draft as { id: string }).id === "simplefin:chk-001")!;
    expect((chk.draft as { display_name: string }).display_name).toBe("Joint Checking");

    // Errlist union: ["error A", "shared error", "error B"] in that insertion order.
    const warnings = ops.filter((o) => o.kind === "sync_warning");
    expect(warnings.map((w) => w.warning.message)).toEqual(["error A", "shared error", "error B"]);
  });

  test("HTTP error mid-pagination → exception propagates, generator throws", async () => {
    const cfg = SimpleFinConfig.parse({ lookback_days: 200 });
    let n = 0;
    const fetchJson: FetchJson = async <T>(): Promise<T> => {
      n += 1;
      if (n === 2) throw new Error("HTTP 502 Bad Gateway");
      return { accounts: [], errlist: [] } as unknown as T;
    };
    const ctx = buildContext({
      config: cfg,
      logger: new ConsoleLogger(SILENT_SINK),
      secrets: staticSecrets({ SIMPLEFIN_ACCESS_URL: "https://u:p@host.example/simplefin" }),
      now: () => new Date("2026-05-01T00:00:00Z"),
    });
    (ctx as { fetchJson: FetchJson }).fetchJson = fetchJson;

    let caught: unknown;
    try {
      await collect(syncSimpleFin(ctx));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("502");
  });
});
