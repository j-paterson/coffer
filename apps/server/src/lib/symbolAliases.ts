/** Symbol normalization — a derive-only layer on top of `positions`.
 *
 * The raw `positions.symbol` is what each source actually reported. This
 * module derives a `canonical_symbol` (e.g. WETH → ETH, USDC.e → USDC)
 * for grouping views without ever overwriting the raw value.
 *
 * Two layers, in priority order:
 *   1. Contract-address overrides (chain-specific wrapped variants).
 *      Most precise — disambiguates "USDC" by chain when one is bridged.
 *   2. Symbol-only mapping. Catches naming conventions across providers
 *      (ETH.CC, ETH-USD, etc.) without on-chain identity.
 *
 * Used by aggregated views (per-canonical-symbol totals across wallets);
 * the per-account dropdown still shows raw symbols so users see exactly
 * what each source reported.
 */

// Symbol → canonical symbol. Wrapped/bridged variants normalize to the
// underlying asset; tickers with provider-specific suffixes get cleaned.
const SYMBOL_MAP: Record<string, string> = {
  // Wrapped + staked + bridged ETH
  WETH: "ETH",
  "ETH.CC": "ETH",
  "ETH-USD": "ETH",
  cbETH: "ETH",
  stETH: "ETH",
  STETH: "ETH",
  wstETH: "ETH",
  WSTETH: "ETH",
  rETH: "ETH",
  RETH: "ETH",
  // Wrapped + bridged BTC
  WBTC: "BTC",
  cbBTC: "BTC",
  "BTC.CC": "BTC",
  // Stablecoin variants
  "USDC.e": "USDC",
  USDbC: "USDC",
  axlUSDC: "USDC",
  // Wrapped/staked SOL
  mSOL: "SOL",
  jitoSOL: "SOL",
  bSOL: "SOL",
  // Wrapped ATOM
  "ATOM.CC": "ATOM",
  // Vanguard fund suffix
  "VTSAX.NA": "VTSAX",
  "VTIAX.NA": "VTIAX",
  // Wayfinder
  PRIME: "PRIME",
  // Internet Computer
  "ICP.CC": "ICP",
};

// Per-(chain, contract) overrides for cases where the symbol alone is
// ambiguous. Keyed `${chain}|${contract.toLowerCase()}`. Mainly bridged
// stablecoins where the symbol matches but the contract differs.
const CONTRACT_MAP: Record<string, string> = {
  // Add as needed — empty for now since the symbol map covers most.
};


/** Return the canonical symbol for a position. Pure function — no DB
 * lookups. Add new mappings to SYMBOL_MAP / CONTRACT_MAP above. */
export function canonicalSymbol(
  symbol: string,
  chain?: string,
  contractAddress?: string,
): string {
  const key = `${chain ?? ""}|${(contractAddress ?? "").toLowerCase()}`;
  if (chain && contractAddress) {
    const hit = CONTRACT_MAP[key];
    if (hit) return hit;
  }
  return SYMBOL_MAP[symbol] ?? SYMBOL_MAP[symbol.toUpperCase()] ?? symbol;
}
