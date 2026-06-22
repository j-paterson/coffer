export interface MakeAssetIdParts {
  chain: string;
  chainRef: string;
  namespace: string;
  reference: string;
}

export function makeAssetId(parts: MakeAssetIdParts): string {
  return `${parts.chain}:${parts.chainRef}/${parts.namespace}:${parts.reference}`;
}

export function makeErc20AssetId(chainId: number, contract: string): string {
  return makeAssetId({
    chain: "eip155",
    chainRef: String(chainId),
    namespace: "erc20",
    reference: contract.toLowerCase(),
  });
}

// SLIP-44 native-asset index, keyed by EVM chain id.
// ETH and all L2s that settle on ETH share slip44:60 by convention.
// Polygon is the lone EVM chain in our scope with its own slip44 index.
const EVM_NATIVE_SLIP44: Record<number, number> = {
  1: 60,        // Ethereum mainnet
  10: 60,       // Optimism
  137: 966,     // Polygon
  8453: 60,     // Base
  42161: 60,    // Arbitrum One
};

export function makeNativeAssetId(chainId: number): string {
  const slip44 = EVM_NATIVE_SLIP44[chainId];
  if (slip44 === undefined) {
    throw new Error(
      `makeNativeAssetId: unknown chain id ${chainId} — use makeAssetId() directly`,
    );
  }
  return makeAssetId({
    chain: "eip155",
    chainRef: String(chainId),
    namespace: "slip44",
    reference: String(slip44),
  });
}

export function makeSplTokenAssetId(mint: string): string {
  return makeAssetId({
    chain: "solana",
    chainRef: "mainnet",
    namespace: "spl-token",
    reference: mint,
  });
}

export function makeFiatAssetId(code: string): string {
  return `fiat:${code}`;
}
