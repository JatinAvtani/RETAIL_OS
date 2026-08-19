-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- the orders sync's cursor + incremental watermark. Advanced ONLY in the
-- same transaction as the order/line writes it gates — the plan's own named top risk is "cursor
-- advances past a failed write, and nothing errors."

ALTER TABLE "pos_connections" ADD COLUMN IF NOT EXISTS "orders_sync_cursor" text;
--> statement-breakpoint
ALTER TABLE "pos_connections" ADD COLUMN IF NOT EXISTS "orders_sync_watermark" timestamp with time zone;
