-- Add per-bundle suggested categories. Stored as JSON for flexibility;
-- the API layer encodes/decodes via JSON.parse/stringify.
ALTER TABLE bundles
  ADD COLUMN category_options TEXT NOT NULL DEFAULT '[]';

-- Backfill existing rows by type. JSON literals here intentionally mirror
-- BUNDLE_TEMPLATES in dashboard/api/src/lib/bundle_templates.ts. Keep them
-- in sync — a unit test in migrations_kind_merge.test.ts asserts equality
-- by re-parsing the column on a freshly-seeded row.
UPDATE bundles
   SET category_options = json('[
     {"category":"Materials","subcategories":["Lumber","Hardware","Paint","Plumbing","Electrical","Tile/Stone"]},
     {"category":"Labor","subcategories":["Contractor","Subcontractor","Permit"]},
     {"category":"Tools","subcategories":["Rental","Purchase"]},
     {"category":"Fixtures","subcategories":["Lighting","Appliances","Cabinetry"]}
   ]')
 WHERE type = 'renovation';

UPDATE bundles
   SET category_options = json('[
     {"category":"Travel","subcategories":["Flights","Trains","Rideshare","Rental car","Fuel"]},
     {"category":"Lodging","subcategories":["Hotel","Airbnb"]},
     {"category":"Food","subcategories":["Restaurant","Groceries","Coffee"]},
     {"category":"Activities","subcategories":["Tickets","Tours","Gear rental"]}
   ]')
 WHERE type = 'trip';

UPDATE bundles
   SET category_options = json('[
     {"category":"Materials","subcategories":[]},
     {"category":"Services","subcategories":[]},
     {"category":"Tools","subcategories":[]}
   ]')
 WHERE type = 'project';
