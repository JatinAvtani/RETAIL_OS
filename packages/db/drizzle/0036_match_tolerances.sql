-- "Avoid alert fatigue on cents." Per-org override for the three-way match's
-- price/quantity tolerances (packages/domain/src/purchasing/three-way-match.ts's
-- DEFAULT_MATCH_TOLERANCES). All nullable, matching memberships.approval_limit's exact
-- precedent -- NULL means "use the default," never a fabricated zero (a zero tolerance would
-- flag every cent of rounding as a variance).
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "match_price_tolerance_percent" numeric(5, 4);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "match_price_tolerance_absolute" numeric(19, 4);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "match_quantity_tolerance_percent" numeric(5, 4);
