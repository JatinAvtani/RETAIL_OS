-- The SEND state transition and the real PDF-generation/email-send side effect that follows it are
-- two separate steps (the transition commits inside applyTransition's own DB transaction; PDF/email
-- happen right after, outside it, since they are not database operations). Before this migration, a
-- PDF-generation or email-send failure after a genuine SEND left the PO's `status` at `SENT` with no
-- distinct, queryable fact recording that delivery never actually completed — the database said
-- "sent" when nothing had reached the supplier. `delivery_status` makes that a real, separate,
-- retryable fact, mirroring `sales_transactions.consumption_status`'s already-established pattern
-- for exactly this shape of problem ("the business event happened, but a side effect of it might
-- not have").
CREATE TYPE "purchase_order_delivery_status" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

ALTER TABLE "purchase_orders"
  ADD COLUMN "delivery_status" "purchase_order_delivery_status" NOT NULL DEFAULT 'PENDING';

ALTER TABLE "purchase_orders"
  ADD COLUMN "delivery_error" text;

ALTER TABLE "purchase_orders"
  ADD COLUMN "delivery_attempts" integer NOT NULL DEFAULT 0;

-- Backfill: every pre-existing PO that already reached SENT (or any state beyond it) under the old
-- all-or-nothing behavior only ever got there by the router's `send` mutation running PDF
-- generation and the (always-succeeding, per this project's mocked-transport precedent) email send
-- to completion before returning — the one real failure mode this migration closes (a genuine
-- thrown error) always left the transaction's caller with a thrown TRPCError and no further
-- automatic state change, so historical SENT-or-later rows are honestly DELIVERED, not a
-- newly-invented PENDING backlog that never existed.
UPDATE "purchase_orders" SET "delivery_status" = 'DELIVERED' WHERE "status" <> 'DRAFT' AND "status" <> 'PENDING_APPROVAL' AND "status" <> 'APPROVED' AND "status" <> 'CANCELLED';

-- Supports the resend/retry path's own query ("find this org's FAILED-or-still-PENDING sent POs")
-- without a sequential scan once real volume exists — same partial-index shape as
-- `sales_transactions_consumption_status_idx`.
CREATE INDEX "purchase_orders_delivery_status_idx"
  ON "purchase_orders" ("organization_id", "delivery_status")
  WHERE "delivery_status" <> 'DELIVERED';
