export const SUPPORTED_CHAINS = [
  "ethereum", "base", "polygon", "optimism", "arbitrum",
] as const;
export type AlchemyChain = (typeof SUPPORTED_CHAINS)[number];

export interface ChainInfo {
  urlSlug: string;
  nativeSymbol: string;
  nativeDecimals: number;
}

export const CHAIN_INFO: Record<AlchemyChain, ChainInfo> = {
  ethereum: { urlSlug: "eth-mainnet",     nativeSymbol: "ETH",   nativeDecimals: 18 },
  base:     { urlSlug: "base-mainnet",    nativeSymbol: "ETH",   nativeDecimals: 18 },
  polygon:  { urlSlug: "polygon-mainnet", nativeSymbol: "MATIC", nativeDecimals: 18 },
  optimism: { urlSlug: "opt-mainnet",     nativeSymbol: "ETH",   nativeDecimals: 18 },
  arbitrum: { urlSlug: "arb-mainnet",     nativeSymbol: "ETH",   nativeDecimals: 18 },
};

export function alchemyUrl(chain: AlchemyChain, apiKey: string): string {
  return `https://${CHAIN_INFO[chain].urlSlug}.g.alchemy.com/v2/${apiKey}`;
}
