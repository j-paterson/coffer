import { posting, type Posting } from "./posting";

export const UNKNOWN_COUNTERPARTY = "equity:unknown-counterparty";
export const OPENING_BALANCE = "equity:opening-balance";
export const UNRECONCILED = "equity:unreconciled";

/** Build the canonical [known_account, equity:unknown-counterparty]
 *  pair for single-sided ingest. The counterparty absorbs the opposite
 *  amount so the transaction balances. The match stage can later
 *  replace the counterparty side with a real account. */
export function oneSided(
  account_id: string,
  amount: number,
  opts: { payee?: string | null; memo?: string | null; currency?: string } = {},
): [Posting, Posting] {
  return [
    posting(account_id, amount, opts),
    posting(UNKNOWN_COUNTERPARTY, -amount, { currency: opts.currency }),
  ];
}
