import { describe, expect, it } from 'vitest';
import {
  planStockMovementsMonthlyPartition,
  planStockMovementsMonthlyPartitions,
  DEFAULT_MONTHS_AHEAD,
} from './stock-movements-partitions';

/**
 * Pure unit tests for the DDL-generation half of partition maintenance — no database connection
 * needed, matching this codebase's own "deterministic core" discipline (CLAUDE.md): given any
 * date, the exact SQL text is fully determined and testable without I/O.
 */
describe('planStockMovementsMonthlyPartition', () => {
  it('generates the exact partition name/bounds/SQL for a normal month (August 2026) — matching 0014_stock_movements.sql\'s own seeded partition exactly', () => {
    const plan = planStockMovementsMonthlyPartition(new Date('2026-08-15T12:00:00Z'));

    expect(plan.tableName).toBe('stock_movements_2026_08');
    expect(plan.fromDateLiteral).toBe('2026-08-01');
    expect(plan.toDateLiteral).toBe('2026-09-01');
    expect(plan.sql).toBe(
      'CREATE TABLE IF NOT EXISTS "stock_movements_2026_08"\n' +
        '  PARTITION OF "stock_movements"\n' +
        "  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');"
    );
  });

  it('rolls over into the next year at a December→January boundary', () => {
    const plan = planStockMovementsMonthlyPartition(new Date('2026-12-25T00:00:00Z'));

    expect(plan.tableName).toBe('stock_movements_2026_12');
    expect(plan.fromDateLiteral).toBe('2026-12-01');
    expect(plan.toDateLiteral).toBe('2027-01-01');
  });

  it('zero-pads single-digit months', () => {
    const plan = planStockMovementsMonthlyPartition(new Date('2027-01-01T00:00:00Z'));

    expect(plan.tableName).toBe('stock_movements_2027_01');
    expect(plan.fromDateLiteral).toBe('2027-01-01');
    expect(plan.toDateLiteral).toBe('2027-02-01');
  });

  it('reads UTC calendar fields, not local time — a date near a UTC day boundary does not shift month due to local offset', () => {
    // 2026-08-31T23:30:00Z is still August in UTC even though many local timezones would already
    // read this as September 1st.
    const plan = planStockMovementsMonthlyPartition(new Date('2026-08-31T23:30:00Z'));
    expect(plan.tableName).toBe('stock_movements_2026_08');
  });
});

describe('planStockMovementsMonthlyPartitions', () => {
  it('returns the current month plus DEFAULT_MONTHS_AHEAD months ahead, inclusive, in order', () => {
    const plans = planStockMovementsMonthlyPartitions(new Date('2026-01-15T00:00:00Z'));

    expect(plans).toHaveLength(DEFAULT_MONTHS_AHEAD + 1);
    expect(plans.map((p) => p.tableName)).toEqual([
      'stock_movements_2026_01',
      'stock_movements_2026_02',
      'stock_movements_2026_03',
      'stock_movements_2026_04',
    ]);
  });

  it('spans a year boundary correctly when starting near year-end', () => {
    const plans = planStockMovementsMonthlyPartitions(new Date('2026-11-01T00:00:00Z'), 3);

    expect(plans.map((p) => p.tableName)).toEqual([
      'stock_movements_2026_11',
      'stock_movements_2026_12',
      'stock_movements_2027_01',
      'stock_movements_2027_02',
    ]);
  });

  it('respects an explicit monthsAhead override, including 0 (current month only)', () => {
    const plans = planStockMovementsMonthlyPartitions(new Date('2026-06-01T00:00:00Z'), 0);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.tableName).toBe('stock_movements_2026_06');
  });

  it('each consecutive plan\'s FROM bound equals the previous plan\'s TO bound — no gap, no overlap', () => {
    const plans = planStockMovementsMonthlyPartitions(new Date('2026-03-01T00:00:00Z'), 5);
    for (let i = 1; i < plans.length; i += 1) {
      expect(plans[i]!.fromDateLiteral).toBe(plans[i - 1]!.toDateLiteral);
    }
  });
});
