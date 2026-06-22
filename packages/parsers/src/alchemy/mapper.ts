import type { AccountDraft, PositionSnapshotDraft } from "@coffer/ledger/runner";
import type { AlchemyChain } from "./chains";
import { CHAIN_INFO } from "./chains";
import type { AlchemyTokenMetadata } from "./client";

/**
 * Convert an Alchemy hex balance (e.g. "0x3b9aca00") to a JS number,
 * dividing by 10^decimals. Returns 0 for unparseable / zero inputs.
 *
 * Precision profile matches Python's `raw / (10 ** decimals)`: exact
 * for values that fit in a JS double, lossy at extreme magnitudes.
 */
export function hexToQty(hex: string, decimals: number): number {
  if (typeof hex !== "string" || !hex.startsWith("0x")) return 0;
  if (hex === "0x") return 0;
  let raw: bigint;
  try {
    raw = BigInt(hex);
  } catch {
    return 0;
  }
  if (raw === 0n) return 0;
  return Number(raw) / Math.pow(10, decimals);
}

function shortAddr(addr: string): string {
  // 0xabcd…ef01 (4-hex prefix after 0x, 4-hex suffix, U+2026 ellipsis)
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function buildAccountDraft(chain: AlchemyChain, addr: string): AccountDraft {
  const addrLower = addr.toLowerCase();
  // The "zerion:" prefix is intentional: it matches the Zerion parser
  // so a single (chain, wallet) maps to one canonical account regardless
  // of which provider wrote the row last. institution + source disambiguate.
  const accountId = `zerion:${chain}:${addrLower}`;
  const titleChain = chain.charAt(0).toUpperCase() + chain.slice(1);
  return {
    id: accountId,
    display_name: `${titleChain} ${shortAddr(addrLower)}`,
    institution: "alchemy",
    type: "crypto",
    currency: "USD",
    mode: "live",
    external_id: accountId,
    source: "alchemy",
  };
}

export function buildNativePosition(opts: {
  chain: AlchemyChain;
  accountId: string;
  qty: number;
  asOf: string;
}): PositionSnapshotDraft {
  return {
    account_id: opts.accountId,
    symbol: CHAIN_INFO[opts.chain].nativeSymbol,
    chain: opts.chain,
    contract_address: null,
    as_of: opts.asOf,
    qty: opts.qty,
    price_usd: null,
    source: "alchemy",
  };
}

export function buildTokenPosition(opts: {
  chain: AlchemyChain;
  accountId: string;
  contract: string;
  rawHex: string;
  metadata: AlchemyTokenMetadata;
  asOf: string;
}): PositionSnapshotDraft | null {
  const symbol = (opts.metadata.symbol ?? "").trim();
  const decimals = opts.metadata.decimals;
  if (symbol.length === 0) return null;
  if (typeof decimals !== "number" || !Number.isFinite(decimals) || decimals < 0) return null;
  const qty = hexToQty(opts.rawHex, decimals);
  if (qty <= 0) return null;
  return {
    account_id: opts.accountId,
    symbol,
    chain: opts.chain,
    contract_address: opts.contract.toLowerCase(),
    as_of: opts.asOf,
    qty,
    price_usd: null,
    source: "alchemy",
  };
}
