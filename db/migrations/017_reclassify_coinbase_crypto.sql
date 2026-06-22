-- Reclassify Coinbase SimpleFIN accounts from 'checking' to 'crypto'.
-- Per-asset wallets ("BTC Wallet", "ETH Wallet", etc.) were being dumped
-- into the checking section because our inference fell through to the
-- default. Going forward the parser classifies crypto exchanges by org
-- name; this statement fixes the rows already in the DB.
UPDATE accounts
   SET type = 'crypto'
 WHERE institution = 'Coinbase'
   AND id LIKE 'simplefin:%'
   AND type = 'checking';
