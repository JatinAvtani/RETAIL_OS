-- Hand-written, not `drizzle-kit generate` output — the snapshot chain has been stale since
-- migration 0005 (see 0008_units_and_conversions.sql's header and project memory for why).
--
-- earlier work: waste reason codes must be a fixed, groupable set, not free text -
-- "Free text here would make the whole module worthless" per the spec's own words. reason_code
-- stays free text for every OTHER movement type (it's already used generically across all of
-- them); this constraint fires ONLY when movement_type = 'WASTE', so it doesn't retroactively
-- restrict what any other movement type may write there.
-- `reason_code IN (...)` evaluates to NULL (not FALSE) when reason_code IS NULL, and `OR NULL`
-- does not fail a CHECK constraint - proven directly via psql before this fix (a WASTE row with a
-- NULL reason_code was wrongly ACCEPTED on the first version of this constraint). The explicit
-- `reason_code IS NOT NULL AND... IN (...)` closes that gap: a WASTE row MUST carry one of the
-- eight real values, never silently skip the requirement via NULL.
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_waste_reason_code"
  CHECK (
    "movement_type" <> 'WASTE'
    OR (
      "reason_code" IS NOT NULL
      AND "reason_code" IN (
        'EXPIRED', 'DAMAGED', 'PREP_ERROR', 'CUSTOMER_RETURN',
        'OVERPRODUCTION', 'SPILLAGE', 'QUALITY_REJECT', 'THEFT_SUSPECTED'
      )
    )
  );
