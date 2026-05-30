import type { Operation } from "@coffer/ledger/runner";
import type {
  ZerionPositionRow,
  ZerionPositionsResponse,
} from "./client";

export interface MapPositionsOpts {
  address: string;
  asOf: string;          // "YYYY-MM-DD"
  minValueUsd: number;
}

export interface MapPositionsResult {
  ops: Generator<Operation>;
  chains: Set<string>;
  fungibles: Set<string>;
}

interface ValidRow {
  symbol: string;
  chain: string;
  fungibleId: string;
  qty: number;
  value: number;
  implementations: Array<{ chain_id: string; address: string | null }>;
}

function pickValid(rows: ZerionPositionRow[], minValueUsd: number): ValidRow[] {
  const out: ValidRow[] = [];
  for (const r of rows) {
    const symbol = r.attributes?.fungible_info?.symbol;
    const qty = r.attributes?.quantity?.float;
    const value = r.attributes?.value;
    const chain = r.relationships?.chain?.data?.id;
    const fungibleId = r.relationships?.fungible?.data?.id;
    if (typeof symbol !== "string" || symbol.length === 0) continue;
    if (typeof qty !== "number" || !Number.isFinite(qty)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (typeof chain !== "string" || chain.length === 0) continue;
    if (typeof fungibleId !== "string" || fungibleId.length === 0) continue;
    if (value < minValueUsd) continue;
    const impls =
      (r.attributes?.fungible_info?.implementations ?? [])
        .filter((i): i is { chain_id: string; address: string | null } =>
          typeof i?.chain_id === "string")
        .map((i) => ({ chain_id: i.chain_id, address: i.address ?? null }));
    out.push({ symbol, chain, fungibleId, qty, value, implementations: impls });
  }
  return out;
}

function resolveContract(row: ValidRow): string | null {
  const match = row.implementations.find((i) => i.chain_id === row.chain);
  if (!match) return null;
  return match.address?.toLowerCase() ?? null;
}

function shortAddr(addr: string): string {
  // 0xabcd…ef01 (4-hex prefix after 0x, 4-hex suffix, horizontal ellipsis U+2026)
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function mapPositions(
  response: ZerionPositionsResponse,
  opts: MapPositionsOpts,
): MapPositionsResult {
  const addr = opts.address.toLowerCase();
  const valid = pickValid(response.data, opts.minValueUsd);

  // Group by chain, preserving first-seen order.
  const byChain = new Map<string, ValidRow[]>();
  for (const row of valid) {
    const bucket = byChain.get(row.chain);
    if (bucket) bucket.push(row);
    else byChain.set(row.chain, [row]);
  }

  const chains = new Set<string>(byChain.keys());
  const fungibles = new Set<string>(valid.map((r) => r.fungibleId));

  function* generate(): Generator<Operation> {
    for (const [chain, rows] of byChain) {
      const accountId = `zerion:${chain}:${addr}`;
      yield {
        kind: "account_discovery",
        draft: {
          id: accountId,
          display_name: `Zerion ${chain} ${shortAddr(addr)}`,
          institution: "zerion",
          type: "crypto_wallet",
          currency: "USD",
          mode: "live",
          external_id: accountId,
          source: "zerion",
        },
      };
      for (const row of rows) {
        const priceUsd = row.qty > 0 && Number.isFinite(row.qty)
          ? row.value / row.qty
          : null;
        yield {
          kind: "position_snapshot",
          draft: {
            account_id: accountId,
            symbol: row.symbol,
            chain: row.chain,
            contract_address: resolveContract(row),
            as_of: opts.asOf,
            qty: row.qty,
            price_usd: priceUsd,
            source: "zerion",
          },
        };
      }
    }
  }

  return { ops: generate(), chains, fungibles };
}

import type { ZerionChartResponse, ZerionFungibleChartResponse } from "./client";

function tsToIsoDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function* mapFungiblePrices(
  response: ZerionFungibleChartResponse,
): Generator<Operation> {
  const attrs = response.data?.attributes;
  const symbol = attrs?.symbol ?? "";
  const impls = attrs?.implementations ?? [];
  const points = attrs?.points ?? [];

  if (impls.length === 0) {
    yield {
      kind: "sync_warning",
      warning: {
        source: "zerion",
        scope: "no_implementations",
        message: `fungible ${symbol} has no implementations`,
        detail: { symbol },
      },
    };
    return;
  }

  for (const point of points) {
    const ts = point[0];
    const price = point[1];
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (typeof price !== "number" || !Number.isFinite(price)) continue;
    if (price <= 0) continue;
    const asOf = tsToIsoDate(ts);
    for (const impl of impls) {
      yield {
        kind: "asset_price",
        draft: {
          chain: impl.chain_id,
          contract_address: impl.address?.toLowerCase() ?? null,
          symbol,
          as_of: asOf,
          source: "zerion",
          price_usd: price,
        },
      };
    }
  }
}

export function* mapWalletChart(
  response: ZerionChartResponse,
  accountId: string,
  source: string,
): Generator<Operation> {
  const points = response.data?.attributes?.points ?? [];
  for (const point of points) {
    const ts = point[0];
    const value = point[1];
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (value < 0) continue;
    yield {
      kind: "assertion",
      draft: {
        account_id: accountId,
        as_of: tsToIsoDate(ts),
        expected_usd: value,
        source,
      },
    };
  }
}
