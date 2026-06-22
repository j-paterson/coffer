import type { Operation } from "@coffer/ledger/runner";
import type { ParserContext } from "../types/parser";
import { paginate } from "../util/paginate";
import { timeWindowAdapter } from "../shared/pagination/time-window";
import {
  fetchAccountsWindow,
  splitAccessUrl,
  USER_AGENT,
  type SimpleFinAccountsResponse,
  type SplitAccessUrl,
} from "./client";
import { mapSimpleFinResponses } from "./mapper";
import type { SimpleFinConfig } from "./config";

const SOURCE = "simplefin";

export async function* syncSimpleFin(
  ctx: ParserContext<SimpleFinConfig>,
): AsyncGenerator<Operation> {
  const c = ctx.config;

  const accessUrl = await ctx.secrets.get(c.access_url_env);
  if (!accessUrl) {
    yield {
      kind: "sync_warning",
      warning: { source: SOURCE, scope: "config", message: `${c.access_url_env} is not set` },
    };
    return;
  }

  let split: SplitAccessUrl;
  try {
    split = splitAccessUrl(accessUrl);
  } catch (err) {
    yield {
      kind: "sync_warning",
      warning: {
        source: SOURCE,
        scope: "config",
        message: `access URL is malformed: ${(err as Error).message}`,
      },
    };
    return;
  }

  const now = ctx.now();
  const start = new Date(now.getTime() - c.lookback_days * 86400 * 1000);
  const WINDOW_MS = 90 * 86400 * 1000;
  const responses: SimpleFinAccountsResponse[] = [];

  const adapter = timeWindowAdapter<SimpleFinAccountsResponse>({
    start, end: now, windowMs: WINDOW_MS,
    async fetchRange(from, to) {
      const r = await fetchAccountsWindow({
        fetchJson: ctx.fetchJson,
        baseUrl: split.baseUrl,
        basicAuthHeader: split.basicAuthHeader,
        startUnix: Math.floor(from.getTime() / 1000),
        endUnix:   Math.floor(to.getTime()   / 1000),
        includePending: c.include_pending,
        userAgent: USER_AGENT,
      });
      return [r];
    },
  });

  for await (const r of paginate(adapter)) responses.push(r);

  const asOf = now.toISOString().slice(0, 10);
  for (const op of mapSimpleFinResponses({
    responses, asOf, overrides: c.account_overrides,
  })) yield op;
}
