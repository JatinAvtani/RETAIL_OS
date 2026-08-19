-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- "deleted upstream items are marked, not deleted — historical sales
-- still reference them." A full catalog sync sets delisted_at on any pos_items row it didn't see
-- in this run; a later sync that sees the item again clears it back to NULL.

ALTER TABLE "pos_items" ADD COLUMN IF NOT EXISTS "delisted_at" timestamp with time zone;
