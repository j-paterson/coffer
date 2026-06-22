import type { Database } from "bun:sqlite";
import {
  buildContext,
  SqliteParserCache,
  ConsoleLogger,
  type Parser,
  type SecretResolver,
} from "@coffer/parsers";
import {
  runOperations,
  type Operation,
  type RunSummary,
} from "@coffer/ledger/runner";
import { LedgerPriceProvider } from "@coffer/ledger";
import { REGISTRY as DEFAULT_REGISTRY } from "./registry";
import type { EventsEmitter } from "./events";
import { resolveCachePath } from "./db";
import { rewrapSchemaError } from "./errors";

export interface RunSyncOpts {
  parserId: string;
  config: unknown;
  db: Database;
  env: SecretResolver;
  events: EventsEmitter;
  now: () => Date;
  genRunId: () => string;
  registry?: Record<string, Parser<unknown>>;
}

export interface RunSyncResult {
  run_id: string;
  ok: boolean;
  summary: RunSummary;
}

export function emptySummary(): RunSummary {
  return {
    raw_events: 0,
    transactions: 0,
    assertions: 0,
    position_snapshots: 0,
    asset_prices: 0,
    accounts_discovered: 0,
    warnings: 0,
  };
}

async function* teeOps(
  src: AsyncIterable<Operation>,
  onOp: (op: Operation) => void,
): AsyncIterable<Operation> {
  for await (const op of src) {
    onOp(op);
    yield op;
  }
}

export async function runSync(opts: RunSyncOpts): Promise<RunSyncResult> {
  const registry = opts.registry ?? (DEFAULT_REGISTRY as Record<string, Parser<unknown>>);
  const parser = registry[opts.parserId];
  if (!parser) throw new Error(`unknown parser id: ${opts.parserId}`);

  const run_id = opts.genRunId();
  let summary: RunSummary = emptySummary();
  let ok = false;

  opts.events.syncStarted({ run_id, sources: [opts.parserId] });
  try {
    const cache = new SqliteParserCache(resolveCachePath());
    try {
      const ctx = buildContext({
        config: opts.config as never,
        cache,
        logger: new ConsoleLogger(),
        secrets: opts.env,
        priceProvider: new LedgerPriceProvider(opts.db),
        now: opts.now,
      });

      const stream = teeOps(
        parser.sync(ctx),
        (op) => {
          if (op.kind === "sync_warning") {
            opts.events.warning({
              run_id,
              account_id: null,
              message: op.warning.message,
            });
          }
        },
      );
      summary = await runOperations(opts.db, stream);
      ok = true;
    } finally {
      cache.close();
    }
  } catch (e) {
    throw rewrapSchemaError(e);
  } finally {
    opts.events.syncFinished({ run_id, ok, totals: { [opts.parserId]: summary } });
  }
  return { run_id, ok, summary };
}
