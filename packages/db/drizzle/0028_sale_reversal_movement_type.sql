-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- earlier work (the plan's own named "subtle part": a refund must reverse the corresponding consumption
-- movements). None of the existing movement_type values fit "a customer refund means ingredients
-- notionally came back" — RETURN_TO_SUPPLIER is a genuinely different real-world event (inventory
-- physically leaving to go back to a vendor). Asked the user, confirmed a dedicated value rather
-- than overloading WASTE or RETURN_TO_SUPPLIER.
ALTER TYPE "movement_type" ADD VALUE IF NOT EXISTS 'SALE_REVERSAL';
