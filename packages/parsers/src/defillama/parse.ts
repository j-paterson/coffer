import type { Operation } from "@coffer/ledger/runner";
import type { ParserContext } from "../types/parser";
import type { FetchJson } from "../types/http";
import type { PageAdapter } from "../util/paginate";
import { paginate } from "../util/paginate";
import { fetchChartChunk, type ChartPoint } from "./client";
import { resolveTargets, mergeCgMap, expandPointsToOps } from "./mapper";
import type { DefiLlamaConfig } from "./config";

const SOURCE = "defillama";

interface ChartAdapterOpts {
  fetchJson: FetchJson;
  baseUrl: string;
  coinKey: string;
  startUnix: number;
  endUnix: number;
}

/**
 * Walk the DefiLlama chart endpoint forward in chunks of `span=500`
 * daily points, advancing the cursor to `max(returned_ts) + 86400` on
 * each iteration. Three termination conditions, all needed:
 *
 *  1. Empty response → coin unknown to DefiLlama, or no history left.
 *  2. nextStart >= endUnix → reached today.
 *  3. nextStart <= cursor.startUnix → no forward progress; guards
 *     against an infinite loop if the API ever stalls.
 */
function chartAdapter(opts: ChartAdapterOpts): PageAdapter<ChartPoint, { startUnix: number }> {
  return {
    initial: { startUnix: opts.startUnix },
    async fetchPage(cursor) {
      if (cursor === null) return { records: [], next: null };
      const { points } = await fetchChartChunk({
        fetchJson: opts.fetchJson,
        baseUrl: opts.baseUrl,
        coinKey: opts.coinKey,
        startUnix: cursor.startUnix,
      });
      if (points.length === 0) return { records: [], next: null };
      const lastTs = Math.max(...points.map((p) => p.ts));
      const nextStart = lastTs + 86400;
      const stop = nextStart <= cursor.startUnix || nextStart >= opts.endUnix;
      return { records: points, next: stop ? null : { startUnix: nextStart } };
    },
  };
}

export async function* syncDefiLlama(
  ctx: ParserContext<DefiLlamaConfig>,
): AsyncGenerator<Operation> {
  const c = ctx.config;
  const cgMap = mergeCgMap(c.cg_overrides);
  const { groups, warnings } = resolveTargets(c.targets, c.floor_date, cgMap);
  for (const w of warnings) yield w;

  const skipSet = new Set(c.skip_coin_keys);
  const activeGroups = groups.filter((g) => !skipSet.has(g.coinKey));
  if (skipSet.size > 0 && activeGroups.length < groups.length) {
    yield {
      kind: "sync_warning",
      warning: {
        source: SOURCE,
        scope: "skipped_cached_misses",
        message: `skipped ${groups.length - activeGroups.length} coin keys with no prior data (30-day cache)`,
      },
    };
  }

  const endUnix = Math.floor(ctx.now().getTime() / 1000);

  for (const group of activeGroups) {
    const startUnix = Math.floor(Date.parse(`${group.since}T00:00:00Z`) / 1000);
    const points: ChartPoint[] = [];

    try {
      for await (const p of paginate(
        chartAdapter({
          fetchJson: ctx.fetchJson,
          baseUrl: c.base_url,
          coinKey: group.coinKey,
          startUnix,
          endUnix,
        }),
      )) {
        points.push(p);
      }
    } catch (err) {
      yield {
        kind: "sync_warning",
        warning: {
          source: SOURCE,
          scope: "fetch_failed",
          message: `fetch failed for ${group.coinKey}: ${(err as Error).message}`,
          detail: { coinKey: group.coinKey },
        },
      };
      continue;
    }

    if (points.length === 0) {
      yield {
        kind: "sync_warning",
        warning: {
          source: SOURCE,
          scope: "no_data",
          message: `no prices returned for ${group.coinKey}`,
          detail: { coinKey: group.coinKey },
        },
      };
      continue;
    }

    for (const op of expandPointsToOps(group, points)) yield op;
  }
}
