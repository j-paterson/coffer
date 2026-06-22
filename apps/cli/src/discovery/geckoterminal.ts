import type { Database } from "bun:sqlite";

export interface GeckoTarget {
  symbol: string;
  chain: string;
  contract: string;
}

interface Row {
  symbol: string;
  chain: string;
  contract_address: string;
}

export function discoverGeckoterminal(db: Database): { targets: GeckoTarget[] } {
  // positions.chain and positions.contract_address are NOT NULL DEFAULT '' —
  // filter on non-empty, not non-null.
  const rows = db
    .query<Row, []>(
      `SELECT DISTINCT symbol, chain, contract_address
         FROM positions
        WHERE contract_address != ''
          AND chain != ''
          AND chain != 'bitcoin'`,
    )
    .all();
  return {
    targets: rows.map((r) => ({
      symbol:   r.symbol,
      chain:    r.chain,
      contract: r.contract_address,
    })),
  };
}
