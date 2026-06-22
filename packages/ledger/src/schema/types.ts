/** Row shapes mirroring db/migrations/*.sql. The TypeScript representation
 * of the schema lives here so callers don't reinvent it per-route. */

export interface RawEventRow {
  id: number;
  source: string;
  source_file: string | null;
  external_id: string;
  payload: string; // serialized JSON
  ingested_at: string; // ISO timestamp
}

export interface TransactionV2Row {
  id: number;
  date: string; // YYYY-MM-DD
  description: string | null;
  notes: string | null;
  derived_by: string;
}

export interface PostingRow {
  id: number;
  txn_id: number;
  account_id: string;
  amount: number;
  currency: string;
  payee: string | null;
  memo: string | null;
}

export interface BalanceAssertionRow {
  account_id: string;
  as_of: string; // YYYY-MM-DD
  expected_usd: number;
  source: string;
  source_file: string | null;
}

export interface PositionRow {
  id: number;
  account_id: string;
  symbol: string;
  chain: string | null;
  contract_address: string | null;
}

export interface PositionSnapshotRow {
  id: number;
  position_id: number;
  as_of: string;
  qty: number;
  price_usd: number | null;
  value_usd: number | null;
  source: string;
}

export interface AssetPriceRow {
  chain: string;
  contract_address: string | null;
  symbol: string;
  as_of: string;
  source: string;
  price_usd: number;
}

export interface AccountRow {
  id: string;
  display_name: string;
  institution: string;
  type: string;
  currency: string;
  mode: "live" | "manual";
  merged_into: string | null;
  active: number;
}

export interface DataSourceRow {
  name: string;
  kind: "snapshot" | "assertion";
  trust_rank: number;
  enabled: number;
}

export interface SchemaMigrationRow {
  version: string;
  applied_at: string;
}

export interface EventLinkRow {
  txn_id: number;
  raw_id: number;
}

export interface ReconciliationNoteRow {
  id: number;
  account_id: string;
  as_of: string;
  kind: string;
  detail: string;
}
