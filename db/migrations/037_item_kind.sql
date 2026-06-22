-- Materials vs Labor classification. Orthogonal to the item category
-- axis (home_renovation, home_hardware, …): every payment in a renovation
-- bundle is either buying stuff (material) or paying someone for their
-- time (labor). For itemized receipts, `kind` lives on the line item.
-- For transactions with no items (ACH to a contractor, handwritten
-- checks), `kind` lives on the transaction; 'mixed' is for transactions
-- that span both sides (e.g., an invoice that combines labor + materials
-- passed through at cost, but we haven't itemized them).
ALTER TABLE transaction_items
  ADD COLUMN kind TEXT CHECK (kind IN ('material', 'labor'));
CREATE INDEX IF NOT EXISTS idx_items_kind ON transaction_items(kind);

ALTER TABLE transactions_v2
  ADD COLUMN kind TEXT CHECK (kind IN ('material', 'labor', 'mixed'));
CREATE INDEX IF NOT EXISTS idx_txnv2_kind ON transactions_v2(kind);
