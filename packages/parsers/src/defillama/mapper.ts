import type { Operation } from "@coffer/ledger/runner";
import type { DefiLlamaTarget } from "./config";

// DefiLlama mostly uses CoinGecko chain names; this table covers the
// non-trivial divergences. Identity mappings are listed so the table
// is the single source of truth for "chains we support".
const CHAIN_ALIASES: Readonly<Record<string, string>> = {
  ethereum: "ethereum",
  base: "base",
  polygon: "polygon",
  arbitrum: "arbitrum",
  optimism: "optimism",
  avalanche: "avax",   // llama uses 'avax'
  scroll: "scroll",
  zora: "zora",
  unichain: "unichain",
  bnb: "bsc",          // llama uses 'bsc'
  solana: "solana",
};

// Major coins lacking on-chain identity in our positions table — fall
// back to coingecko:<id> coin keys. Lifted verbatim from
// pipeline/src/finance_pipeline/backfill_defillama.py:55-87.
export const DEFAULT_CG_MAP: Readonly<Record<string, string>> = {
  ETH: "ethereum",
  BTC: "bitcoin",
  USDC: "usd-coin",
  USDT: "tether",
  SOL: "solana",
  ATOM: "cosmos",
  ICP: "internet-computer",
  OSMO: "osmosis",
  JUNO: "juno-network",
  AVAX: "avalanche-2",
  MANA: "decentraland",
  TIA: "celestia",
  MKR: "maker",
  DAI: "dai",
  BCH: "bitcoin-cash",
  LTC: "litecoin",
  ZEC: "zcash",
  ETC: "ethereum-classic",
  BAT: "basic-attention-token",
  ZRX: "0x",
  SUI: "sui",
  SEI: "sei-network",
  OP: "optimism",
  ARB: "arbitrum",
  DNT: "district0x",
  LOOM: "loom-network-new",
  GNT: "golem",
  CVC: "civic",
  PRIME: "echelon-prime",
  WBTC: "wrapped-bitcoin",
  WETH: "weth",
};

/**
 * Resolve a (symbol, chain, contract) triple to a DefiLlama coin_key,
 * or null when no resolution exists.
 *
 * Prefer `<chain>:<contract>` (lowercased) for on-chain identity —
 * this catches bridged variants like USDC.e where the contract address
 * is the distinguishing feature. Fall back to `coingecko:<id>` for
 * majors without on-chain identity in our positions table.
 */
export function buildCoinKey(
  t: { symbol: string; chain: string | null; contract: string | null },
  cgMap: Record<string, string | null>,
): string | null {
  const chainL = (t.chain ?? "").toLowerCase();
  const contractL = (t.contract ?? "").toLowerCase();
  if (chainL && contractL) {
    return `${CHAIN_ALIASES[chainL] ?? chainL}:${contractL}`;
  }
  const cgId = cgMap[t.symbol.toUpperCase()];
  return cgId ? `coingecko:${cgId}` : null;
}

/**
 * Merge user-supplied CG overrides on top of the parser's default map.
 *
 * Override keys are normalized to uppercase so callers can write
 * `{ eth: null }` to suppress the default `{ ETH: "ethereum" }` entry
 * — without normalization, the two keys would coexist and the
 * uppercase lookup would still hit the default.
 *
 * `null` values flow through as explicit suppression markers; the
 * downstream `buildCoinKey` treats null/undefined identically (no
 * fallback). String values either extend or replace.
 */
export function mergeCgMap(
  overrides: Record<string, string | null>,
): Record<string, string | null> {
  const upperOverrides: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(overrides)) {
    upperOverrides[k.toUpperCase()] = v;
  }
  return { ...DEFAULT_CG_MAP, ...upperOverrides };
}

const SOURCE = "defillama";

export interface ResolvedIdentity {
  symbol: string;
  chain: string | null;
  contract: string | null;
}

export interface ResolvedGroup {
  coinKey: string;
  identities: ResolvedIdentity[];
  since: string;  // ISO date, min across all identities
}

/**
 * Convert a flat list of targets into a deduped-by-coin_key set of
 * fetch groups, plus a list of sync_warning ops for targets that
 * couldn't be resolved to a DefiLlama coin_key.
 *
 * Dedup rule: multiple targets resolving to the same coin_key (e.g.
 * WETH on ethereum + WETH on base both → coingecko:weth) collapse
 * into one group with multiple identities. The group's `since` is the
 * earliest across all member identities (so the fetch covers
 * everyone's resume point); per-identity `since` is not preserved
 * because the price stream is shared.
 *
 * Output groups are sorted by coinKey for deterministic test output.
 */
export function resolveTargets(
  targets: DefiLlamaTarget[],
  floorDate: string,
  cgMap: Record<string, string | null>,
): { groups: ResolvedGroup[]; warnings: Operation[] } {
  const byKey = new Map<string, ResolvedGroup>();
  const warnings: Operation[] = [];

  for (const t of targets) {
    const key = buildCoinKey(t, cgMap);
    if (key === null) {
      warnings.push({
        kind: "sync_warning",
        warning: {
          source: SOURCE,
          scope: "unresolved_target",
          message: `${t.symbol} (${t.chain || "no-chain"}) has no DefiLlama coin key`,
          detail: { symbol: t.symbol, chain: t.chain, contract: t.contract },
        },
      });
      continue;
    }

    const since = t.since ?? floorDate;
    const identity: ResolvedIdentity = {
      symbol: t.symbol,
      chain: t.chain,
      contract: t.contract,
    };

    const existing = byKey.get(key);
    if (existing) {
      existing.identities.push(identity);
      if (since < existing.since) existing.since = since;  // ISO dates compare lexically
    } else {
      byKey.set(key, { coinKey: key, identities: [identity], since });
    }
  }

  const groups = [...byKey.values()].sort((a, b) => a.coinKey.localeCompare(b.coinKey));
  return { groups, warnings };
}

/**
 * Fan a single coin's price stream out to per-identity asset_price ops.
 *
 * One op per (point × identity). The output PK matches
 * AssetPriceDraft `(chain, contract_address, symbol, as_of, source)` so
 * the runner's INSERT … ON CONFLICT … DO UPDATE handles re-runs
 * idempotently.
 *
 * `chain` is coerced to "" when identity.chain is null (AssetPriceDraft
 * requires string, not nullable). This matches the Python convention
 * (`chain or ""`).
 */
export function* expandPointsToOps(
  group: ResolvedGroup,
  points: { ts: number; price: number }[],
): Generator<Operation> {
  for (const p of points) {
    const dateIso = new Date(p.ts * 1000).toISOString().slice(0, 10);
    for (const id of group.identities) {
      yield {
        kind: "asset_price",
        draft: {
          chain: id.chain ?? "",
          contract_address: id.contract,
          symbol: id.symbol,
          as_of: dateIso,
          source: SOURCE,
          price_usd: p.price,
        },
      };
    }
  }
}
