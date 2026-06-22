import type { Posting } from "../gatekeepers/posting";

/** External reference: a (source, external_id) pair pointing at a
 *  raw_events row. Used by transaction/assertion ops to declare their
 *  audit links without requiring the parser to track row ids. */
export interface ExternalRef {
  source: string;
  external_id: string;
}

/** Capabilities a parser advertises. Surfaced in the UI: "SimpleFIN
 *  provides transactions + balances for 12 accounts." */
export type Capability =
  | "transactions"
  | "balances"
  | "positions"
  | "prices"
  | "accounts";

/** Drafts: payload shapes for each operation. They mirror the
 *  gatekeeper inputs but lack runtime concerns (raw_ids the parser
 *  doesn't know yet, db handles, etc). */

export interface TransactionDraft {
  date: string;
  description: string | null;
  postings: Posting[];
  derived_by?: string;
  category?: string | null;
  notes?: string | null;
}

export interface OneSidedDraft {
  date: string;
  description: string | null;
  account_id: string;
  amount: number;
  currency?: string;
  payee?: string | null;
  memo?: string | null;
  derived_by?: string;
  category?: string | null;
  notes?: string | null;
}

export interface AssertionDraft {
  account_id: string;
  as_of: string;
  expected_usd: number;
  source: string;
  source_file?: string | null;
}

export interface PositionSnapshotDraft {
  account_id: string;
  symbol: string;
  chain: string | null;
  contract_address: string | null;
  as_of: string;
  qty: number;
  price_usd: number | null;
  source: string;
}

export interface AssetPriceDraft {
  chain: string;
  contract_address: string | null;
  symbol: string;
  as_of: string;
  source: string;
  price_usd: number;
}

export interface AccountDraft {
  id: string;
  display_name: string;
  institution: string;
  type: string;
  currency?: string;
  mode: "live" | "manual";
  external_id?: string | null;
  source?: string | null;
}

export interface SyncWarning {
  source: string;
  scope: string | null;
  message: string;
  detail?: unknown;
}

/** The Operation union: every kind of side-effect a parser can
 *  request. The runner is the only thing that translates these into
 *  gatekeeper calls. Parsers cannot reach the DB except through this
 *  channel. */
export type Operation =
  | { kind: "raw_event"; source: string; external_id: string; payload: unknown; source_file?: string | null }
  | { kind: "transaction"; draft: TransactionDraft; event_refs?: ExternalRef[] }
  | { kind: "one_sided"; draft: OneSidedDraft; event_refs?: ExternalRef[] }
  | { kind: "assertion"; draft: AssertionDraft; event_refs?: ExternalRef[] }
  | { kind: "position_snapshot"; draft: PositionSnapshotDraft; event_refs?: ExternalRef[] }
  | { kind: "asset_price"; draft: AssetPriceDraft }
  | { kind: "account_discovery"; draft: AccountDraft }
  | { kind: "sync_warning"; warning: SyncWarning };
