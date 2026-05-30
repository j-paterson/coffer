-- 008_sender_profiles.sql
-- Lightweight router for email extraction.
--
-- Each sender address is tagged with a type that drives what happens when
-- we see a new receipt from that sender:
--
--   subscription -> skip entirely (we don't need items from subs; the merchant
--                   alone is the whole signal)
--   amazon       -> route to the dedicated Amazon text parser (fast, accurate,
--                   handles multi-order emails)
--   retail       -> generic NuExtract extraction (the long tail of online
--                   goods retailers — the main insight target)
--   service      -> NuExtract, but low priority (Uber, DoorDash, etc.)
--   noise        -> skip entirely (TestFlight, tracking-only, etc.)
--   unknown      -> default path (NuExtract) until we learn otherwise
--
-- Rows land here two ways:
--   1. Initial seeds applied by a one-off Python helper
--   2. Learned on-the-fly: after each extraction, if the result pattern
--      matches "subscription", we upsert the from_addr as subscription

CREATE TABLE sender_profiles (
  from_addr   TEXT PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN
                ('subscription','amazon','retail','service','noise','unknown')),
  learned_from TEXT,  -- 'seed' | 'extraction' | 'manual'
  note        TEXT,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sender_profiles_type ON sender_profiles(type);
