import type { Database } from "bun:sqlite";

export interface DefillamaTarget {
  symbol: string;
  chain: string;
  contract: string;
  since: string | null;
}

interface Row {
  symbol: string;
  chain: string;            // NOT NULL DEFAULT '' in schema
  contract_address: string; // NOT NULL DEFAULT '' in schema
  first_date: string | null;
}

export function discoverDefillama(db: Database): { targets: DefillamaTarget[]; skip_coin_keys: string[] } {
  const rows = db
    .query<Row, []>(
      `SELECT p.symbol,
              p.chain,
              p.contract_address,
              MIN(t.date) AS first_date
         FROM positions p
         LEFT JOIN postings post ON post.account_id = p.account_id
         LEFT JOIN transactions_v2 t ON t.id = post.txn_id
        WHERE p.asset_class = 'crypto'
        GROUP BY p.symbol, p.chain, p.contract_address`,
    )
    .all();

  const misses = db
    .query<{ coin_key: string }, [string]>(
      `SELECT coin_key FROM price_source_misses
       WHERE source = ? AND last_checked > datetime('now', '-30 days')`,
    )
    .all("defillama")
    .map((r) => r.coin_key);

  return {
    targets: rows.map((r) => ({
      symbol:   r.symbol,
      chain:    r.chain,
      contract: r.contract_address,
      since:    r.first_date,
    })),
    skip_coin_keys: misses,
  };
}
