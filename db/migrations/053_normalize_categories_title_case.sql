-- 053_normalize_categories_title_case.sql
--
-- Normalize transaction_items.category to match the canonical Title Case
-- values declared in rules.yaml. Migration 048 lowercased everything,
-- but the categorizer writes Title Case — creating split buckets on the
-- spending page (e.g. "utilities" vs "Utilities").
--
-- Also maps legacy fine-grained categories (home_renovation, electronics,
-- etc.) into the canonical set. Old category value is preserved as
-- subcategory when subcategory is currently NULL.

-- Preserve old fine-grained category as subcategory before overwriting
UPDATE transaction_items
SET subcategory = category
WHERE subcategory IS NULL
  AND category IN (
    'accessories', 'automotive', 'clothing', 'credit_interest',
    'drinks', 'electronics', 'home_appliance', 'home_appliance_cleaning',
    'home_decoration', 'home_furniture', 'home_hardware', 'home_lighting',
    'home_renovation', 'investment_loss', 'labor', 'materials', 'mixed',
    'outdoors', 'personal_care', 'snacks', 'transportation',
    'travel_accessories', 'vehicle', 'debt_payment'
  );

-- Case-only fixes (same semantic meaning)
UPDATE transaction_items SET category = 'Auto'          WHERE category = 'auto';
UPDATE transaction_items SET category = 'Cash'          WHERE category = 'cash';
UPDATE transaction_items SET category = 'Entertainment' WHERE category = 'entertainment';
UPDATE transaction_items SET category = 'Fees'          WHERE category = 'fees';
UPDATE transaction_items SET category = 'Groceries'     WHERE category = 'grocery';
UPDATE transaction_items SET category = 'Income'        WHERE category = 'income';
UPDATE transaction_items SET category = 'Personal'      WHERE category = 'personal';
UPDATE transaction_items SET category = 'Pets'          WHERE category = 'pets';
UPDATE transaction_items SET category = 'Restaurants'   WHERE category = 'restaurants';
UPDATE transaction_items SET category = 'Shopping'      WHERE category = 'shopping';
UPDATE transaction_items SET category = 'Software'      WHERE category = 'software';
UPDATE transaction_items SET category = 'Taxes'         WHERE category = 'taxes';
UPDATE transaction_items SET category = 'Transfer'      WHERE category = 'transfer';
UPDATE transaction_items SET category = 'Travel'        WHERE category = 'travel';
UPDATE transaction_items SET category = 'Utilities'     WHERE category = 'utilities';

-- Semantic mappings (old category → canonical bucket)
UPDATE transaction_items SET category = 'Auto'          WHERE category IN ('automotive', 'vehicle', 'transportation');
UPDATE transaction_items SET category = 'Fees'          WHERE category IN ('credit_interest', 'investment_loss');
UPDATE transaction_items SET category = 'Groceries'     WHERE category = 'groceries';
UPDATE transaction_items SET category = 'Personal'      WHERE category = 'personal_care';
UPDATE transaction_items SET category = 'Restaurants'   WHERE category IN ('drinks', 'snacks');
UPDATE transaction_items SET category = 'Shopping'      WHERE category IN ('accessories', 'clothing', 'electronics', 'home_appliance', 'home_appliance_cleaning', 'home_decoration', 'home_furniture', 'home_hardware', 'home_lighting', 'home_renovation', 'labor', 'materials', 'mixed');
UPDATE transaction_items SET category = 'Entertainment' WHERE category = 'outdoors';
UPDATE transaction_items SET category = 'Transfer'      WHERE category = 'debt_payment';
UPDATE transaction_items SET category = 'Travel'        WHERE category = 'travel_accessories';
UPDATE transaction_items SET category = 'Uncategorized' WHERE category = 'unknown';

-- cost-basis importer wallet movements (BUY/SELL/SEND/RECEIVE/TRADE) are transfers
UPDATE transaction_items
SET subcategory = COALESCE(subcategory, 'crypto'),
    category = 'Transfer'
WHERE category = 'crypto';
