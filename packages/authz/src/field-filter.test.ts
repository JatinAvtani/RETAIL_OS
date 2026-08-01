import { describe, expect, it } from 'vitest';
import type { AuthContext } from './auth-context';
import { filterSensitiveFields } from './field-filter';
import { permissionsForRole } from './role-permissions';

const makeCtx = (overrides: Partial<AuthContext> = {}): AuthContext => ({
  userId: 'user-1',
  organizationId: 'org-1',
  storeIds: 'ALL',
  role: 'STAFF',
  permissions: permissionsForRole('STAFF'),
  ...overrides,
});

const COST_FIELDS = ['costPrice', 'marginPercent'] as const;

describe('filterSensitiveFields', () => {
  it('deletes sensitive fields for a role without financial:read (Staff)', () => {
    const ctx = makeCtx();
    const result = filterSensitiveFields(
      ctx,
      { id: 'item-1', name: 'Flour', costPrice: 12.5, marginPercent: 40 },
      COST_FIELDS
    );

    expect('costPrice' in result).toBe(false);
    expect('marginPercent' in result).toBe(false);
    expect(result).toEqual({ id: 'item-1', name: 'Flour' });
  });

  it('deletes the key entirely rather than setting it to null', () => {
    const ctx = makeCtx();
    const result = filterSensitiveFields(ctx, { id: 'item-1', costPrice: 12.5 }, COST_FIELDS);

    expect(Object.keys(result)).not.toContain('costPrice');
    expect(Object.prototype.hasOwnProperty.call(result, 'costPrice')).toBe(false);
  });

  it('leaves fields untouched for a role with financial:read (Manager)', () => {
    const ctx = makeCtx({ role: 'MANAGER', permissions: permissionsForRole('MANAGER') });
    const input = { id: 'item-1', name: 'Flour', costPrice: 12.5, marginPercent: 40 };
    const result = filterSensitiveFields(ctx, input, COST_FIELDS);

    expect(result).toEqual(input);
  });

  it('leaves fields untouched for VIEWER_FINANCE (financial:read but not an operational role)', () => {
    const ctx = makeCtx({ role: 'VIEWER_FINANCE', permissions: permissionsForRole('VIEWER_FINANCE') });
    const result = filterSensitiveFields(ctx, { costPrice: 12.5 }, COST_FIELDS);

    expect(result).toEqual({ costPrice: 12.5 });
  });

  it('applies recursively across an array of items', () => {
    const ctx = makeCtx();
    const result = filterSensitiveFields(
      ctx,
      [
        { id: 'a', costPrice: 1 },
        { id: 'b', costPrice: 2 },
      ],
      COST_FIELDS
    );

    expect(result).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('applies to nested objects, covering facet/aggregate shapes', () => {
    const ctx = makeCtx();
    const result = filterSensitiveFields(
      ctx,
      {
        storeId: 'store-1',
        summary: { totalSpend: 50_000, orderCount: 12 },
      },
      ['totalSpend']
    );

    expect('totalSpend' in result.summary).toBe(false);
    expect(result).toEqual({ storeId: 'store-1', summary: { orderCount: 12 } });
  });

  it('does not mutate the original object', () => {
    const ctx = makeCtx();
    const input = { id: 'item-1', costPrice: 12.5 };
    filterSensitiveFields(ctx, input, COST_FIELDS);

    expect(input).toEqual({ id: 'item-1', costPrice: 12.5 });
  });

  it('is a no-op passthrough (same reference) when the field list has no matches', () => {
    const ctx = makeCtx({ role: 'MANAGER', permissions: permissionsForRole('MANAGER') });
    const input = { id: 'item-1' };

    expect(filterSensitiveFields(ctx, input, COST_FIELDS)).toBe(input);
  });
});
