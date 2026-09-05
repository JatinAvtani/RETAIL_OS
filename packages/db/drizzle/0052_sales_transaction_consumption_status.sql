-- Sale-to-inventory-consumption is currently a synchronous, unguarded call: if consumption throws
-- partway through a Square sync's page loop, the sales rows already committed stay correct, but
-- nothing records that their consumption never ran, and the sync's own loop aborts entirely,
-- silently skipping consumption for every remaining transaction it hadn't reached yet.
-- consumption_status turns that into a real, queryable fact per transaction so a failure is visible
-- and retryable rather than invisible.
CREATE TYPE "sales_transaction_consumption_status" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

ALTER TABLE "sales_transactions"
  ADD COLUMN "consumption_status" "sales_transaction_consumption_status" NOT NULL DEFAULT 'PENDING';

ALTER TABLE "sales_transactions"
  ADD COLUMN "consumption_error" text;

ALTER TABLE "sales_transactions"
  ADD COLUMN "consumption_attempts" integer NOT NULL DEFAULT 0;

-- Backfill: every pre-existing row was consumed synchronously at ingest time under the old
-- fire-and-forget behavior with no failure ever recorded, so treating history as COMPLETED is the
-- honest default — a real, not-yet-processed backlog does not exist before this column did.
UPDATE "sales_transactions" SET "consumption_status" = 'COMPLETED';

-- Supports the retry sweep's own query ("find PENDING/FAILED rows, oldest first") without a
-- sequential scan once real volume exists.
CREATE INDEX "sales_transactions_consumption_status_idx"
  ON "sales_transactions" ("organization_id", "consumption_status")
  WHERE "consumption_status" <> 'COMPLETED';
