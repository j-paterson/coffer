-- Transfer pairs: an outbound transaction on one account paired with
-- the matching inbound transaction on another. When both sides are
-- paired, the networth reconstruction drops them from the txn-walk —
-- they cancel at the portfolio level, so treating them as balance
-- deltas inflates spurious debt/gain.
--
-- Populated by `finance reconcile transfers` via three layers:
--   * hash      — same on-chain tx hash on both sides
--   * bank      — Coinbase / exchange withdrawal ↔ bank deposit match
--                 (descriptor + amount + date window)
--   * amount_date — generic amount+date match between compatible account
--                   pairs (crypto↔crypto, crypto↔bank, etc.)
-- Manual entries (match_kind='manual') come from a CLI override.
CREATE TABLE transfer_pairs (
  out_txn_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  in_txn_id  TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  match_kind TEXT NOT NULL,
  confidence REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (out_txn_id, in_txn_id)
);
CREATE INDEX idx_transfer_pairs_out ON transfer_pairs(out_txn_id);
CREATE INDEX idx_transfer_pairs_in  ON transfer_pairs(in_txn_id);
