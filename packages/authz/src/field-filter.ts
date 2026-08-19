import { hasPermission, type AuthContext } from './auth-context';
import type { Permission } from './permission';

/**
 * the design enforcement rule 3: a caller without `financial:read` (Staff) must have cost/margin
 * fields deleted from the response, not nulled — `'costPrice' in result` must be false, since a
 * present-but-null field still confirms the field's existence and shape to the client.
 */
export const SENSITIVE_FIELD_PERMISSION: Permission = 'financial:read';

/**
 * Deletes `sensitiveFields` from a plain object when `ctx` lacks `financial:read` (Staff). Applied
 * recursively to arrays and to nested plain objects, so it also covers facet/aggregate shapes
 * — a nested `{ topSupplier: { totalSpend:... } }` is filtered the same as
 * a top-level cost field, not just the outermost object.
 *
 * Returns the same reference when nothing needed removing (no-op for Owner/Manager/Accountant), and
 * a shallow-cloned structure only where fields were actually deleted.
 */
export const filterSensitiveFields = <T>(
  ctx: AuthContext,
  value: T,
  sensitiveFields: readonly string[]
): T => {
  if (hasPermission(ctx, SENSITIVE_FIELD_PERMISSION)) {
    return value;
  }
  return stripFields(value, new Set(sensitiveFields));
};

const stripFields = <T>(value: T, sensitiveFields: ReadonlySet<string>): T => {
  if (Array.isArray(value)) {
    return value.map((item) => stripFields(item, sensitiveFields)) as unknown as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (sensitiveFields.has(key)) {
      continue;
    }
    result[key] = stripFields(val, sensitiveFields);
  }
  return result as T;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !(value instanceof Date) &&
  Object.getPrototypeOf(value) === Object.prototype;
