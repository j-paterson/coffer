import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "@coffer/ledger/schema";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadParserConfig,
  ConfigLoadError,
  ConfigParseError,
  mergeConfig,
  isEmptyTargetSet,
} from "../../src/config/load";
import { SKIP } from "../../src/skip";
import { SchemaOutdatedError } from "../../src/errors";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, "../../../../db/migrations");
const FIXTURES = resolve(HERE, "../fixtures");

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, MIGRATIONS_DIR);
  return db;
}

describe("mergeConfig — non-target parsers", () => {
  test("shallow merge; user overrides discovered", () => {
    expect(mergeConfig("simplefin", { lookback_days: 30 }, {})).toEqual({ lookback_days: 30 });
    expect(mergeConfig("zerion", { wallets: ["0xabc"] }, {})).toEqual({ wallets: ["0xabc"] });
  });
});

describe("mergeConfig — defillama target union", () => {
  test("auto-discovered targets pass through when user entry empty", () => {
    const out = mergeConfig(
      "defillama",
      {},
      { targets: [{ symbol: "ETH", chain: "ethereum", contract: "", since: null }] },
    ) as { targets: unknown[] };
    expect(out.targets.length).toBe(1);
  });

  test("user targets win on (symbol, chain, contract) conflict — entire user row replaces discovered row", () => {
    const out = mergeConfig(
      "defillama",
      {
        targets: [
          { symbol: "USDC", chain: "ethereum", contract: "0xa0b", since: "2024-01-01" },
        ],
      },
      {
        targets: [
          { symbol: "USDC", chain: "ethereum", contract: "0xa0b", since: null },
          { symbol: "WETH", chain: "ethereum", contract: "0xc02", since: null },
        ],
      },
    ) as { targets: { symbol: string; since: string | null }[] };
    expect(out.targets.length).toBe(2);
    const usdc = out.targets.find((t) => t.symbol === "USDC");
    expect(usdc?.since).toBe("2024-01-01"); // user's `since` preserved
    expect(out.targets.find((t) => t.symbol === "WETH")).toBeDefined();
  });

  test("ordering: user targets first, then non-conflicting discovered", () => {
    const out = mergeConfig(
      "defillama",
      { targets: [{ symbol: "USDC", chain: "ethereum", contract: "0xa0b", since: null }] },
      { targets: [{ symbol: "WETH", chain: "ethereum", contract: "0xc02", since: null }] },
    ) as { targets: { symbol: string }[] };
    expect(out.targets.map((t) => t.symbol)).toEqual(["USDC", "WETH"]);
  });
});

describe("mergeConfig — geckoterminal target union", () => {
  test("same key-based union semantics", () => {
    const out = mergeConfig(
      "geckoterminal",
      { targets: [{ symbol: "USDC", chain: "ethereum", contract: "0xa0b", from: "2024-01-01" }] },
      { targets: [{ symbol: "USDC", chain: "ethereum", contract: "0xa0b" }] },
    ) as { targets: { symbol: string; from?: string }[] };
    expect(out.targets.length).toBe(1);
    expect(out.targets[0]!.from).toBe("2024-01-01");
  });
});

describe("isEmptyTargetSet", () => {
  test("true only for defillama/geckoterminal with empty targets", () => {
    expect(isEmptyTargetSet("defillama",     { targets: [] })).toBe(true);
    expect(isEmptyTargetSet("geckoterminal", { targets: [] })).toBe(true);
    expect(isEmptyTargetSet("defillama",     { targets: [{}] })).toBe(false);
    expect(isEmptyTargetSet("geckoterminal", { targets: [{}] })).toBe(false);
    expect(isEmptyTargetSet("simplefin",     { targets: [] })).toBe(false);
    expect(isEmptyTargetSet("coinbase",      {})).toBe(false);
    expect(isEmptyTargetSet("alchemy",       { wallets: [] })).toBe(false);
  });

  test("false when targets is missing entirely", () => {
    expect(isEmptyTargetSet("defillama", {})).toBe(false);
  });
});

describe("loadParserConfig — missing file", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(()  => { db.close(); });

  test("absent config + non-required parser → returns parsed defaults", async () => {
    const out = await loadParserConfig({
      path:     resolve(FIXTURES, "no-such-file.ts"),
      parserId: "simplefin",
      db,
    });
    // simplefin has all-default fields, so parse succeeds with empty input.
    expect(out).not.toBe(SKIP);
    expect((out as { lookback_days: number }).lookback_days).toBe(90);
  });

  test("absent config + parser with strict-min targets + empty DB → SKIP", async () => {
    const out = await loadParserConfig({
      path:     resolve(FIXTURES, "no-such-file.ts"),
      parserId: "geckoterminal",
      db,
    });
    expect(out).toBe(SKIP);
  });

  test("absent config + defillama + empty DB → SKIP", async () => {
    const out = await loadParserConfig({
      path:     resolve(FIXTURES, "no-such-file.ts"),
      parserId: "defillama",
      db,
    });
    expect(out).toBe(SKIP);
  });
});

describe("loadParserConfig — happy paths", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(()  => { db.close(); });

  test("empty config file + simplefin → returns parsed defaults", async () => {
    const out = await loadParserConfig({
      path:     resolve(FIXTURES, "empty-config.ts"),
      parserId: "simplefin",
      db,
    });
    expect(out).not.toBe(SKIP);
    expect((out as { lookback_days: number }).lookback_days).toBe(90);
  });

  test("manual defillama target + empty DB → parses with the manual target", async () => {
    const out = await loadParserConfig({
      path:     resolve(FIXTURES, "defillama-manual.ts"),
      parserId: "defillama",
      db,
    });
    expect(out).not.toBe(SKIP);
    const cfg = out as { targets: Array<{ symbol: string; since: string | null }> };
    expect(cfg.targets.length).toBe(1);
    expect(cfg.targets[0]!.symbol).toBe("USDC");
    expect(cfg.targets[0]!.since).toBe("2024-01-01");
  });

  test("manual defillama target + seeded DB → merged set with manual `since` preserved", async () => {
    db.exec(`
      INSERT INTO accounts (id, display_name, institution, type, mode)
        VALUES ('a1', 'eth', 'self', 'crypto', 'live');
      INSERT INTO positions (account_id, asset_class, symbol, chain, contract_address)
        VALUES ('a1', 'crypto', 'USDC', 'ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
      INSERT INTO positions (account_id, asset_class, symbol, chain, contract_address)
        VALUES ('a1', 'crypto', 'WETH', 'ethereum', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
    `);
    const out = await loadParserConfig({
      path:     resolve(FIXTURES, "defillama-manual.ts"),
      parserId: "defillama",
      db,
    });
    const cfg = out as { targets: Array<{ symbol: string; since: string | null }> };
    // Manual USDC + auto-discovered WETH (auto-USDC superseded).
    expect(cfg.targets.length).toBe(2);
    const usdc = cfg.targets.find((t) => t.symbol === "USDC");
    expect(usdc?.since).toBe("2024-01-01"); // manual wins
  });
});

describe("loadParserConfig — error paths", () => {
  let db: Database;
  beforeEach(() => { db = freshDb(); });
  afterEach(()  => { db.close(); });

  test("ConfigLoadError when file throws on import (syntax error)", async () => {
    await expect(
      loadParserConfig({
        path:     resolve(FIXTURES, "syntax-error.ts"),
        parserId: "simplefin",
        db,
      }),
    ).rejects.toBeInstanceOf(ConfigLoadError);
  });

  test("ConfigLoadError when default export missing", async () => {
    await expect(
      loadParserConfig({
        path:     resolve(FIXTURES, "no-default.ts"),
        parserId: "simplefin",
        db,
      }),
    ).rejects.toBeInstanceOf(ConfigLoadError);
  });

  test("ConfigParseError when merged config fails Zod", async () => {
    await expect(
      loadParserConfig({
        path:     resolve(FIXTURES, "bad-simplefin.ts"),
        parserId: "simplefin",
        db,
      }),
    ).rejects.toBeInstanceOf(ConfigParseError);
  });

  test("SchemaOutdatedError rewrap when discovery query hits a missing table", async () => {
    const brokenDb = new Database(":memory:");
    brokenDb.exec("PRAGMA foreign_keys = ON");
    // No migrations applied — positions table doesn't exist.
    try {
      await expect(
        loadParserConfig({
          path:     resolve(FIXTURES, "no-such-file.ts"),
          parserId: "defillama",
          db:       brokenDb,
        }),
      ).rejects.toBeInstanceOf(SchemaOutdatedError);
    } finally {
      brokenDb.close();
    }
  });
});
