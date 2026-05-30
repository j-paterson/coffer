-- Drop the v1 transfer_pairs table. v2 spending excludes transfers via
-- posting structure (a transfer txn has two real-account legs; spending
-- has one real leg + one equity leg), so the dedup table is dead.
-- The reconcile_transfers.py + dedup_txns.py modules that wrote to it
-- have been deleted.

DROP TABLE IF EXISTS transfer_pairs;
