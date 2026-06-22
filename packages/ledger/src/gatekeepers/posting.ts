/** Single side of a transaction. Sign convention: positive = inflow,
 *  negative = outflow, sum across postings of one transaction = 0 per
 *  currency. Mirrors pipeline/src/finance_pipeline/ledger.py:Posting. */
export interface Posting {
  account_id: string;
  amount: number;
  currency: string;
  payee?: string | null;
  memo?: string | null;
}

/** Constructor with a USD default for the common case. */
export function posting(
  account_id: string,
  amount: number,
  opts: { currency?: string; payee?: string | null; memo?: string | null } = {},
): Posting {
  return {
    account_id,
    amount,
    currency: opts.currency ?? "USD",
    payee: opts.payee ?? null,
    memo: opts.memo ?? null,
  };
}
