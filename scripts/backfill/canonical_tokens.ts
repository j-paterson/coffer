/** Canonical (chain, contract) identities for tokens we want to price.
 *
 * Each entry tells the DefiLlama backfill exactly which coin to fetch
 * and which dimensions to write into asset_prices. Native tokens use
 * contract_address='' and chain set to the native chain identifier
 * (mirrors how backfill_alchemy_history writes native positions).
 *
 * Multi-chain tokens get one entry per chain — they have different
 * prices only infrequently but are different DefiLlama IDs.
 *
 * `defillama_id` forms:
 *   - `coingecko:<slug>` for native / non-EVM / not-on-DefiLlama-by-contract
 *   - `<chain>:<contract>` for EVM tokens DefiLlama prices via oracle
 */

export type CanonicalToken = {
  symbol: string;          // UPPERCASE symbol as stored in positions
  chain: string;           // matches positions.chain — '' for non-chain assets
  contract_address: string;  // lowercase contract, '' for native
  defillama_id: string;    // how DefiLlama wants to be queried
  min_peak_cb?: number;    // tier-B tracking only, informational
};

// L2 EVM native gas is ETH; treating base/optimism/arbitrum/zora/scroll/
// unichain natives as ETH-priced. Alchemy-history's _NATIVE_SYMBOL does
// the same thing.
const ETH_L2S = ["ethereum", "base", "optimism", "arbitrum", "zora", "scroll", "unichain"];

const NATIVE: Array<[string, string, string, string[]]> = [
  // [symbol, cg_slug, native_chain, aliases/extra chains]
  ["BTC", "bitcoin", "bitcoin", []],
  ["SOL", "solana", "solana", []],
  ["ATOM", "cosmos", "cosmos", []],
  ["AVAX", "avalanche-2", "avalanche", []],
  ["DOGE", "dogecoin", "dogecoin", []],
  ["TIA", "celestia", "celestia", []],
  ["ICP", "internet-computer", "internet-computer", []],
  ["DOT", "polkadot", "polkadot", []],
  ["LTC", "litecoin", "litecoin", []],
  ["BCH", "bitcoin-cash", "bitcoin-cash", []],
  ["ETC", "ethereum-classic", "ethereum-classic", []],
  ["XTZ", "tezos", "tezos", []],
  ["ALGO", "algorand", "algorand", []],
  ["SUI", "sui", "sui", []],
  ["SEI", "sei-network", "sei-network", []],
  ["ZEC", "zcash", "zcash", []],
];

const EVM: Array<[string, string, string]> = [
  // [symbol, chain, contract_lowercase] — DefiLlama id = `<chain>:<contract>`
  // USDC — one canonical contract per chain
  ["USDC", "ethereum", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
  ["USDC", "base",     "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"],
  ["USDC", "optimism", "0x0b2c639c533813f4aa9d7837caf62653d097ff85"],
  ["USDC", "arbitrum", "0xaf88d065e77c8cc2239327c5edb3a432268e5831"],
  ["USDC", "polygon",  "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"],
  // USDT
  ["USDT", "ethereum", "0xdac17f958d2ee523a2206206994597c13d831ec7"],
  ["USDT", "arbitrum", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"],
  ["USDT", "optimism", "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58"],
  ["USDT", "polygon",  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f"],
  // DAI
  ["DAI", "ethereum", "0x6b175474e89094c44da98b954eedeac495271d0f"],
  ["DAI", "base",     "0x50c5725949a6f0c72e6c4a641f24049a917db0cb"],
  ["DAI", "optimism", "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1"],
  ["DAI", "arbitrum", "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1"],
  ["DAI", "polygon",  "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"],
  // WETH
  ["WETH", "ethereum", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"],
  ["WETH", "base",     "0x4200000000000000000000000000000000000006"],
  ["WETH", "optimism", "0x4200000000000000000000000000000000000006"],
  ["WETH", "arbitrum", "0x82af49447d8a07e3bd95bd0d56f35241523fbab1"],
  // WBTC
  ["WBTC", "ethereum", "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"],
  // stETH / rETH (liquid staking) — ethereum only
  ["STETH", "ethereum", "0xae7ab96520de3a18e5e111b5eaab095312d7fe84"],
  ["RETH", "ethereum", "0xae78736cd615f374d3085123a210448e74fc6393"],
  ["RETH", "base",     "0xb6fe221fe9eef5aba221c348ba20a1bf5e73624c"],
  // Popular mainnet tokens
  ["LINK", "ethereum", "0x514910771af9ca656af840dff83e8264ecf986ca"],
  ["MKR",  "ethereum", "0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2"],
  ["MANA", "ethereum", "0x0f5d2fb29fb7d3cfee444a200298f468908cc942"],
  ["BAT",  "ethereum", "0x0d8775f648430679a709e98d2b0cb6250d2887ef"],
  ["ZRX",  "ethereum", "0xe41d2489571d322189246dafa5ebde1f4699f498"],
  ["DNT",  "ethereum", "0x0abdace70d3790235af448c88547603b945604ea"],
  ["LOOM", "ethereum", "0xa4e8c3ec456107ea67d3075bf9e3df3a75823db0"],
  ["GNT",  "ethereum", "0xa74476443119a942de498590fe1f2454d7d4ac0d"], // Golem (legacy)
  ["CVC",  "ethereum", "0x41e5560054824ea6b0732e656e3ad64e20e94e45"],
  // L2 Tokens
  ["OP",   "optimism", "0x4200000000000000000000000000000000000042"],
  ["ARB",  "arbitrum", "0x912ce59144191c1204e64559fe8253a0e49e6548"],
  ["MATIC","ethereum", "0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0"],
  // Base-native memecoins we actually priced previously
  ["DEGEN", "base", "0x4ed4e862860bed51a9570b96d89af5e1b0efefed"],
  ["AERO",  "base", "0x940181a94a35a4569e4529a3cdfb74e38fd98631"],
  ["TOBY",  "base", "0xb8d98a102b0079b69ffbc760c8d857a31653e56e"],
  ["HIGHER","base", "0x0578d8a44db98b23bf096a382e016e29a5ce0ffe"],
  ["BRETT", "base", "0x532f27101965dd16442e59d40670faf5ebb142e4"],
  ["MOXIE", "base", "0x8c9037d1ef5c6d1f6816278c7aaf5491d24cd527"],
  ["VIRTUAL","base","0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b"],
  ["BUILD", "base", "0x3c281a39944a2319aa653d81cfd93ca10983d234"],
  ["SPACE", "base", "0x48c87cdacb6bb6bf6e5cd85d8ee5c847084c7410"],
  ["PRIME", "base", "0xfa980ced6895ac314e7de34ef1bfae90a5add21b"],
  ["CLANKER","base","0x1bc0c42215582d5a085795f4badbac3ff36d1bcb"],
  ["ANON",  "base", "0x0db510e79909666d6dec7f5e49370838c16d950f"],
  ["DOG",   "ethereum", "0xbaac2b4491727d78d2b78815144570b9f2fe8899"],
  ["WLFI",  "ethereum", "0xfe1b6abc39e46cec54d275efb4b29b33be176c2a"],
  ["MONA",  "ethereum", "0x275f5ad03be0fa221b4c6649b8aee09a42d9412a"],
  ["STG",   "ethereum", "0xaf5191b0de278c7286d6c7cc6ab6bb8a73ba2cd6"],
  ["VVV",   "base",     "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf"],
];

export const CANONICAL_TOKENS: CanonicalToken[] = [
  // ETH native on every L2 we care about
  ...ETH_L2S.map(chain => ({
    symbol: "ETH", chain, contract_address: "",
    defillama_id: "coingecko:ethereum",
  })),
  // Other natives — chain is native-chain string
  ...NATIVE.map(([sym, slug, native]) => ({
    symbol: sym, chain: native, contract_address: "",
    defillama_id: `coingecko:${slug}`,
  })),
  // EVM tokens — defillama id is `<chain>:<contract>`
  ...EVM.map(([sym, chain, contract]) => ({
    symbol: sym, chain, contract_address: contract,
    defillama_id: `${chain}:${contract}`,
  })),
];
