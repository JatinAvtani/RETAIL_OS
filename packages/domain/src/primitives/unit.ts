/**
 * Units are grouped by dimension. Cross-dimension conversion (e.g. mass -> volume)
 * is never a plain factor — it is product-specific (density) and must go through
 * a per-product conversion, not this table. This table only covers same-dimension,
 * globally-true conversions (kg <-> g, l <-> ml, case-of-N -> each is NOT here
 * because "case" size is per-product).
 */
export type MassUnit = 'mg' | 'g' | 'kg';
export type VolumeUnit = 'ml' | 'l';
export type CountUnit = 'each';

export type Unit = MassUnit | VolumeUnit | CountUnit;

export type UnitDimension = 'mass' | 'volume' | 'count';

const DIMENSION_BY_UNIT: Record<Unit, UnitDimension> = {
  mg: 'mass',
  g: 'mass',
  kg: 'mass',
  ml: 'volume',
  l: 'volume',
  each: 'count',
};

export const dimensionOf = (unit: Unit): UnitDimension => DIMENSION_BY_UNIT[unit];

/** Global, dimension-internal conversion factors, expressed as "1 unit = factor base units". */
const MASS_BASE_UNIT: MassUnit = 'g';
const MASS_FACTOR: Record<MassUnit, number> = { mg: 0.001, g: 1, kg: 1000 };

const VOLUME_BASE_UNIT: VolumeUnit = 'ml';
const VOLUME_FACTOR: Record<VolumeUnit, number> = { ml: 1, l: 1000 };

/**
 * Global unit-to-unit factor within the same dimension. Returns null across dimensions
 * or for 'each', which has no global conversion (I6: only explicit, boundary conversions).
 */
export const globalConversionFactor = (from: Unit, to: Unit): number | null => {
  if (dimensionOf(from) !== dimensionOf(to)) return null;

  if (dimensionOf(from) === 'mass') {
    const f = MASS_FACTOR[from as MassUnit];
    const t = MASS_FACTOR[to as MassUnit];
    return f / t;
  }

  if (dimensionOf(from) === 'volume') {
    const f = VOLUME_FACTOR[from as VolumeUnit];
    const t = VOLUME_FACTOR[to as VolumeUnit];
    return f / t;
  }

  // 'count' dimension: only 'each' exists, and from === to was already handled by identity.
  return from === to ? 1 : null;
};

export { MASS_BASE_UNIT, VOLUME_BASE_UNIT };
