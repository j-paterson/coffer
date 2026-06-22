import { EnvSecretResolver, DbSecretResolver } from "@coffer/parsers";
import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { openProductionDb } from "./db";
import { runSync, emptySummary, type RunSyncResult } from "./run";
import { REGISTRY, type ParserId } from "./registry";
import { makeEventsEmitter } from "./events";
import { loadParserConfig, ConfigLoadError, ConfigParseError } from "./config/load";
import { SchemaOutdatedError } from "./errors";
import { SKIP } from "./skip";

const VALID_PARSER_IDS = Object.keys(REGISTRY) as ParserId[];

export interface ParsedArgs {
  command: "sync";
  parserId: ParserId;
  flags: { days?: number; eventsFd?: number; config?: string };
}

export class ArgvError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ArgvError";
  }
}

export function usage(): string {
  return [
    "Usage:",
    "  coffer sync <parser-id> [--days N] [--events-fd N] [--config <path>]",
    "",
    "Parser ids:",
    "  " + VALID_PARSER_IDS.join(", "),
    "",
    "Flags:",
    "  --days N         (simplefin only) override lookback_days",
    "  --events-fd N    emit SyncEvent JSON-lines on the given fd",
    "  --config <path>  override the default ./finance.config.ts",
  ].join("\n");
}

export function parseArgv(argv: string[]): ParsedArgs {
  if (argv.length === 0) throw new ArgvError("missing command");
  const [command, ...rest] = argv;
  if (command !== "sync") throw new ArgvError(`unknown command: ${command}`);
  if (rest.length === 0) throw new ArgvError("sync: missing parser id");
  const [parserId, ...flagArgs] = rest;
  if (!VALID_PARSER_IDS.includes(parserId as ParserId)) {
    throw new ArgvError(`unknown parser id: ${parserId}`);
  }
  const flags: { days?: number; eventsFd?: number; config?: string } = {};
  for (let i = 0; i < flagArgs.length; i++) {
    const f = flagArgs[i]!;
    if (f === "--days") {
      const v = flagArgs[++i];
      const n = Number(v);
      if (v == null || !Number.isFinite(n) || !Number.isInteger(n)) {
        throw new ArgvError(`--days expects an integer, got: ${String(v)}`);
      }
      flags.days = n;
    } else if (f === "--events-fd") {
      const v = flagArgs[++i];
      const n = Number(v);
      if (v == null || !Number.isFinite(n) || !Number.isInteger(n)) {
        throw new ArgvError(`--events-fd expects an integer, got: ${String(v)}`);
      }
      flags.eventsFd = n;
    } else if (f === "--config") {
      const v = flagArgs[++i];
      if (v == null) throw new ArgvError("--config expects a path");
      flags.config = v;
    } else {
      throw new ArgvError(`unknown flag: ${f}`);
    }
  }
  return { command: "sync", parserId: parserId as ParserId, flags };
}

function printSummary(parserId: ParserId, result: RunSyncResult): void {
  const s = result.summary;
  process.stdout.write(
    [
      `${parserId}: run completed`,
      `  raw_events:          ${s.raw_events}`,
      `  transactions:        ${s.transactions}`,
      `  accounts_discovered: ${s.accounts_discovered}`,
      `  position_snapshots:  ${s.position_snapshots}`,
      `  asset_prices:        ${s.asset_prices}`,
      `  assertions:          ${s.assertions}`,
      `  warnings:            ${s.warnings}`,
      `  run_id:              ${result.run_id}`,
      "",
    ].join("\n"),
  );
}

function genRunId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export async function runMain(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgv(argv);
  } catch (e) {
    if (e instanceof ArgvError) {
      process.stderr.write(`error: ${e.message}\n${usage()}\n`);
      return 2;
    }
    process.stderr.write(`error: ${(e as Error).message}\n${usage()}\n`);
    return 2;
  }

  let db: Database;
  try {
    db = openProductionDb();
  } catch (e) {
    process.stderr.write(`error: cannot open database: ${(e as Error).message}\n`);
    return 1;
  }

  const events = makeEventsEmitter(parsed.flags.eventsFd);
  const configPath = resolve(parsed.flags.config ?? "./finance.config.ts");

  try {
    let resolvedConfig: unknown;
    try {
      resolvedConfig = await loadParserConfig({
        path: configPath,
        parserId: parsed.parserId,
        db,
      });
    } catch (e) {
      if (e instanceof ConfigLoadError || e instanceof ConfigParseError) {
        process.stderr.write(`error: ${e.message}\n`);
        return 2;
      }
      if (e instanceof SchemaOutdatedError) {
        process.stderr.write(`error: ${e.message}\n`);
        return 1;
      }
      throw e;
    }

    if (resolvedConfig === SKIP) {
      const runId = genRunId();
      events.syncStarted({ run_id: runId, sources: [parsed.parserId] });
      events.syncFinished({
        run_id: runId,
        ok: true,
        totals: { [parsed.parserId]: emptySummary() },
      });
      process.stdout.write(`${parsed.parserId}: no eligible targets (0 ops)\n`);
      return 0;
    }

    if (parsed.parserId === "simplefin" && parsed.flags.days != null) {
      (resolvedConfig as { lookback_days?: number }).lookback_days = parsed.flags.days;
    }

    try {
      const result = await runSync({
        parserId: parsed.parserId,
        config: resolvedConfig,
        db,
        env: new DbSecretResolver(db, new EnvSecretResolver()),
        events,
        now: () => new Date(),
        genRunId,
      });
      printSummary(parsed.parserId, result);
      return result.ok ? 0 : 1;
    } catch (e) {
      process.stderr.write(`error: ${(e as Error).stack ?? (e as Error).message}\n`);
      if (e instanceof SchemaOutdatedError) return 1;
      return 1;
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const code = await runMain(process.argv.slice(2));
  process.exit(code);
}
