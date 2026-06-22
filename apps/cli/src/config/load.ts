import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { PARSER_SCHEMAS, type FinanceConfigInput, type ParserId } from "@coffer/config";
import { runDiscovery } from "../discovery";
import { SKIP, type SkipSentinel } from "../skip";
import { rewrapSchemaError } from "../errors";

export class ConfigLoadError extends Error {
  constructor(m: string) {
    super(m);
    this.name = "ConfigLoadError";
  }
}

export class ConfigParseError extends Error {
  constructor(m: string) {
    super(m);
    this.name = "ConfigParseError";
  }
}

export interface LoadConfigOpts {
  path: string;     // absolute path; caller resolves
  parserId: ParserId;
  db: Database;
}

interface TargetRow {
  symbol: string;
  chain: string | null;
  contract: string | null;
}

const targetKey = (t: TargetRow): string => `${t.symbol}|${t.chain ?? ""}|${t.contract ?? ""}`;

export function mergeConfig(
  parserId: ParserId,
  user: Record<string, unknown>,
  discovered: Record<string, unknown>,
): Record<string, unknown> {
  if (parserId !== "defillama" && parserId !== "geckoterminal") {
    return { ...discovered, ...user };
  }
  const out: Record<string, unknown> = { ...discovered, ...user };
  const dTargets = (discovered.targets as TargetRow[] | undefined) ?? [];
  const uTargets = (user.targets       as TargetRow[] | undefined) ?? [];
  const seen = new Set(uTargets.map(targetKey));
  out.targets = [...uTargets, ...dTargets.filter((t) => !seen.has(targetKey(t)))];
  return out;
}

export function isEmptyTargetSet(parserId: ParserId, merged: Record<string, unknown>): boolean {
  if (parserId !== "defillama" && parserId !== "geckoterminal") return false;
  const targets = merged.targets;
  return Array.isArray(targets) && targets.length === 0;
}

export async function loadParserConfig(
  opts: LoadConfigOpts,
): Promise<unknown | SkipSentinel> {
  let userInput: FinanceConfigInput = {};
  if (existsSync(opts.path)) {
    let mod: { default?: FinanceConfigInput };
    try {
      mod = await import(pathToFileURL(opts.path).href);
    } catch (e) {
      throw new ConfigLoadError(`${opts.path}: failed to import — ${(e as Error).message}`);
    }
    if (!mod.default) {
      throw new ConfigLoadError(`${opts.path}: missing default export`);
    }
    userInput = mod.default;
  }

  const fileEntry = (userInput.parsers?.[opts.parserId] ?? {}) as Record<string, unknown>;
  // DB-stored per-provider config (from in-app connections) overrides the
  // file. Only present when the provider_connections table exists and has a
  // row for this parser.
  let dbEntry: Record<string, unknown> = {};
  try {
    const row = opts.db
      .prepare("SELECT config_json FROM provider_connections WHERE parser_id = ?")
      .get(opts.parserId) as { config_json: string } | undefined;
    if (row?.config_json) dbEntry = JSON.parse(row.config_json) as Record<string, unknown>;
  } catch {
    // table absent (older DB) → no DB config; ignore
  }
  const userEntry = { ...fileEntry, ...dbEntry };
  let discovered: Record<string, unknown>;
  try {
    discovered = runDiscovery(opts.parserId, opts.db);
  } catch (e) {
    throw rewrapSchemaError(e);
  }

  const merged = mergeConfig(opts.parserId, userEntry, discovered);
  if (isEmptyTargetSet(opts.parserId, merged)) return SKIP;

  const schema = PARSER_SCHEMAS[opts.parserId];
  const parsed = schema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigParseError(`${opts.parserId}: config invalid:\n${parsed.error.message}`);
  }
  return parsed.data;
}
