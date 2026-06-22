#!/usr/bin/env bun
/** Derive the "blessed" (chain, contract) list from cached Alchemy
 * transfers in raw_events.
 *
 * A contract is blessed if it appears in a tx hash where our wallet was
 * the `from` of *any* transfer at that hash. That captures:
 *   - direct sends (you push token out)
 *   - swaps (you send ETH, receive token at same hash from pool)
 *   - stakes / deposits (you send to protocol)
 *   - LP mints (you send tokens to router)
 *
 * Airdropped scam tokens — where `to=you` but you never signed a tx
 * involving that contract — are excluded.
 *
 * Emits: scripts/backfill/blessed_contracts.ts (generated). */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";

const DB_PATH = resolve(import.meta.dir, "../../db/finance.sqlite");
const OUT_PATH = resolve(import.meta.dir, "blessed_contracts.ts");

const db = new Database(DB_PATH, { readonly: true });

type Transfer = {
  chain: string;
  walletAddr: string;
  hash: string;
  from: string;
  to: string;
  contract: string;  // '' for native
  symbol: string;
};

const rows = db.prepare(
  `SELECT external_id, payload FROM raw_events WHERE source = 'alchemy-history'`
).all() as Array<{ external_id: string; payload: string }>;

const transfers: Transfer[] = [];
for (const r of rows) {
  const parts = r.external_id.split(":");
  if (parts.length < 5) continue;
  const chain = parts[1];
  const walletAddr = parts[2].toLowerCase();
  const hash = parts[3];
  let p: { from?: string; to?: string; rawContract?: { address?: string }; asset?: string };
  try { p = JSON.parse(r.payload); } catch { continue; }
  const from = (p.from || "").toLowerCase();
  const to = (p.to || "").toLowerCase();
  const contract = (p.rawContract?.address || "").toLowerCase();
  const symbol = (p.asset || "").toUpperCase();
  transfers.push({ chain, walletAddr, hash, from, to, contract, symbol });
}

// Per wallet: tx hashes where wallet was `from` on at least one transfer.
const selfInitiated = new Map<string, Set<string>>(); // key = chain|wallet → set of hashes
for (const t of transfers) {
  if (t.from !== t.walletAddr) continue;
  const key = `${t.chain}|${t.walletAddr}`;
  if (!selfInitiated.has(key)) selfInitiated.set(key, new Set());
  selfInitiated.get(key)!.add(t.hash);
}

// Collect (chain, contract, symbol) from all transfers in self-initiated txs.
type Agg = { chain: string; contract: string; symbol: string; n_txs: number; wallets: Set<string>; symbols: Set<string> };
const byKey = new Map<string, Agg>();
for (const t of transfers) {
  const key = `${t.chain}|${t.walletAddr}`;
  if (!selfInitiated.get(key)?.has(t.hash)) continue;
  const k = `${t.chain}::${t.contract}`;
  if (!byKey.has(k)) {
    byKey.set(k, {
      chain: t.chain,
      contract: t.contract,
      symbol: t.symbol,
      n_txs: 0,
      wallets: new Set(),
      symbols: new Set(),
    });
  }
  const a = byKey.get(k)!;
  a.wallets.add(t.walletAddr);
  a.symbols.add(t.symbol);
  a.n_txs++;
}

// Represent blessed by most-common symbol per contract.
type Blessed = { chain: string; contract: string; symbol: string; defillama_id: string; n_txs: number; wallets: number };
const blessed: Blessed[] = [];
for (const a of byKey.values()) {
  if (!a.contract) continue;  // native handled separately below
  const symbols = [...a.symbols].filter(Boolean);
  const symbol = symbols.sort((x, y) => y.length - x.length)[0] || "?";
  blessed.push({
    chain: a.chain,
    contract: a.contract,
    symbol: symbol.toUpperCase(),
    defillama_id: `${a.chain}:${a.contract}`,
    n_txs: a.n_txs,
    wallets: a.wallets.size,
  });
}
blessed.sort((a, b) => b.n_txs - a.n_txs);

// Native tokens — one entry per chain we have activity on. For Coinbase
// wallets (native BTC/SOL/ATOM/etc.) we also keep the canonical-chain
// natives from a small fixed map, since those don't appear in Alchemy
// EVM transfers at all.
const EVM_NATIVES: Record<string, { cg: string }> = {
  ethereum: { cg: "ethereum" },
  base: { cg: "ethereum" },
  optimism: { cg: "ethereum" },
  arbitrum: { cg: "ethereum" },
  polygon: { cg: "matic-network" },
  avalanche: { cg: "avalanche-2" },
  zora: { cg: "ethereum" },
  scroll: { cg: "ethereum" },
  unichain: { cg: "ethereum" },
};
const NON_EVM_NATIVES: Array<[string, string, string]> = [
  // [symbol, chain (matches positions), cg-slug]
  ["BTC", "bitcoin", "bitcoin"],
  ["SOL", "solana", "solana"],
  ["ATOM", "cosmos", "cosmos"],
  ["TIA", "celestia", "celestia"],
  ["ICP", "internet-computer", "internet-computer"],
  ["DOT", "polkadot", "polkadot"],
  ["LTC", "litecoin", "litecoin"],
  ["BCH", "bitcoin-cash", "bitcoin-cash"],
  ["ETC", "ethereum-classic", "ethereum-classic"],
  ["XTZ", "tezos", "tezos"],
  ["ALGO", "algorand", "algorand"],
  ["SUI", "sui", "sui"],
  ["SEI", "sei-network", "sei-network"],
  ["ZEC", "zcash", "zcash"],
  ["DOGE", "dogecoin", "dogecoin"],
  ["AVAX", "avalanche", "avalanche-2"],
];

// Chains where we saw native activity (wallet was `from` of a transfer
// where rawContract='' or the transfer was an `external` category).
const nativeChains = new Set<string>();
for (const t of transfers) {
  if (t.from !== t.walletAddr) continue;
  if (t.contract === "") nativeChains.add(t.chain);
}

const natives: Blessed[] = [];
for (const chain of nativeChains) {
  if (!(chain in EVM_NATIVES)) continue;
  const cg = EVM_NATIVES[chain].cg;
  // Pick a symbol based on chain — ETH L2s get "ETH", polygon gets "MATIC", avalanche gets "AVAX"
  const symbol = chain === "polygon" ? "MATIC" : chain === "avalanche" ? "AVAX" : "ETH";
  natives.push({ chain, contract: "", symbol, defillama_id: `coingecko:${cg}`, n_txs: 0, wallets: 0 });
}
for (const [sym, chain, cg] of NON_EVM_NATIVES) {
  natives.push({ chain, contract: "", symbol: sym, defillama_id: `coingecko:${cg}`, n_txs: 0, wallets: 0 });
}

// Emit blessed_contracts.ts
const lines: string[] = [];
lines.push("// AUTO-GENERATED by scripts/backfill/derive_blessed.ts.");
lines.push("// Re-run that script after new Alchemy ingest to refresh.");
lines.push("// Blessed = (chain, contract) tuples where our wallet signed at least one");
lines.push("// tx involving the contract. Filters out scam airdrops by design.");
lines.push("");
lines.push("export type BlessedToken = {");
lines.push("  symbol: string;         // UPPERCASE, most-common in transfers");
lines.push("  chain: string;          // matches positions.chain");
lines.push("  contract_address: string; // lowercase; '' for native");
lines.push("  defillama_id: string;   // 'chain:contract' or 'coingecko:slug' for native");
lines.push("  n_txs?: number;         // txs user initiated involving this contract");
lines.push("  wallets?: number;       // distinct wallets that touched it");
lines.push("};");
lines.push("");
lines.push("export const BLESSED_TOKENS: BlessedToken[] = [");
for (const b of [...natives, ...blessed]) {
  lines.push(`  { symbol: ${JSON.stringify(b.symbol)}, chain: ${JSON.stringify(b.chain)}, contract_address: ${JSON.stringify(b.contract)}, defillama_id: ${JSON.stringify(b.defillama_id)}, n_txs: ${b.n_txs}, wallets: ${b.wallets} },`);
}
lines.push("];");
writeFileSync(OUT_PATH, lines.join("\n") + "\n");

console.log(`Wrote ${OUT_PATH}`);
console.log(`  ${natives.length} natives (chain-level)`);
console.log(`  ${blessed.length} EVM contracts from self-initiated txs`);
console.log(`\nTop blessed by tx count:`);
for (const b of blessed.slice(0, 20)) {
  console.log(`  ${b.chain.padEnd(10)} ${b.contract} ${b.symbol.padEnd(10)} (${b.n_txs} txs, ${b.wallets} wallets)`);
}
