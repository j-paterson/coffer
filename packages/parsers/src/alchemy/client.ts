import type { FetchJson } from "../types/http";
import { makeJsonRpc, type JsonRpcClient } from "../shared/jsonrpc/client";
import { alchemyUrl, type AlchemyChain } from "./chains";

/** Builds an RPC client for one (chain, apiKey) pair. */
export function makeAlchemyRpc(opts: {
  fetchJson: FetchJson;
  chain: AlchemyChain;
  apiKey: string;
}): JsonRpcClient {
  return makeJsonRpc({
    url: alchemyUrl(opts.chain, opts.apiKey),
    fetchJson: opts.fetchJson,
  });
}

/** Returns the native-coin wei balance for `address` as a "0x..." hex string. */
export async function getNativeBalance(
  rpc: JsonRpcClient,
  address: string,
): Promise<string> {
  return rpc.call<string>("eth_getBalance", [address.toLowerCase(), "latest"]);
}

export interface AlchemyTokenBalance {
  contractAddress: string;
  tokenBalance: string | null;
}

export interface AlchemyTokenBalancesResult {
  address?: string;
  tokenBalances?: AlchemyTokenBalance[];
}

export async function getTokenBalances(
  rpc: JsonRpcClient,
  address: string,
): Promise<AlchemyTokenBalancesResult> {
  return rpc.call<AlchemyTokenBalancesResult>(
    "alchemy_getTokenBalances",
    [address.toLowerCase()],
  );
}

export interface AlchemyTokenMetadata {
  name?: string | null;
  symbol?: string | null;
  decimals?: number | null;
  logo?: string | null;
}

export async function getTokenMetadata(
  rpc: JsonRpcClient,
  contract: string,
): Promise<AlchemyTokenMetadata> {
  return rpc.call<AlchemyTokenMetadata>(
    "alchemy_getTokenMetadata",
    [contract.toLowerCase()],
  );
}
