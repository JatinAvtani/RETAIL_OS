/**
 * Presentation formatting for numeric strings that arrive at full storage precision.
 *
 * The API deliberately returns quantities and money as exact decimal STRINGS (never floats), at
 * the schema's full scale — `1.000000`, `369666.666662`, `350.0000`. That precision is a storage
 * contract, not a display choice: a human reading "Yield: 1.000000" or an on-hand figure with six
 * trailing digits and no unit label is being shown database internals. These helpers trim the
 * noise without ever rounding a value to something it isn't — trailing zeros carry no
 * information, so removing them cannot change the number.
 */

/** `'1.000000'` → `'1'`, `'0.0010'` → `'0.001'`, `'369666.666662'` unchanged. Integers pass through. */
export const trimZeros = (value: string | number): string => {
  const s = String(value);
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
};

/**
 * A quantity with its unit label — `('369666.666662', 'g')` → `'369,666.666662 g'`. The unit is
 * as load-bearing as the digits: a bare stock figure can be off by 1000× in the reader's head
 * depending on whether they assume grams or kilograms, which is exactly the class of silent error
 * explicit units exist to prevent. Falls back to the bare number only when no unit is known —
 * never invents one.
 */
export const formatQuantity = (value: string | number, unitCode?: string | null): string => {
  const trimmed = trimZeros(value);
  const [intPart, fracPart] = trimmed.split('.');
  const grouped = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const num = fracPart !== undefined ? `${grouped}.${fracPart}` : grouped;
  return unitCode ? `${num} ${unitCode}` : num;
};

/**
 * Money at display precision with its currency code — `('350.0000', 'INR')` → `'INR 350.00'`.
 * Always two decimal places (money is communicated in minor units, and `'350'` vs `'350.00'`
 * read differently in a financial column), currency code rather than a symbol (the org's code is
 * data we have; a symbol mapping we'd have to invent is not).
 */
/**
 * Decimal-point shift by whole places, string-only — division/multiplication by powers of ten
 * without ever touching a float (0.07 * 100 === 7.000000000000001 in floats; a stored decimal
 * must round-trip exactly). Returns the input unchanged when it isn't a plain decimal number.
 */
export const shiftDecimalPoint = (value: string, places: number): string => {
  const trimmed = value.trim();
  const sign = trimmed.startsWith('-') ? '-' : '';
  const digitsOnly = trimmed.replace(/^[-+]/, '');
  if (!/^\d+\.?\d*$|^\.\d+$/.test(digitsOnly)) return value;
  const [intRaw = '', fracRaw = ''] = digitsOnly.split('.');
  const digits = intRaw + fracRaw;
  let pointIndex = intRaw.length + places;
  let padded = digits;
  if (pointIndex < 0) {
    padded = '0'.repeat(-pointIndex) + digits;
    pointIndex = 0;
  }
  if (pointIndex > padded.length) padded = padded + '0'.repeat(pointIndex - padded.length);
  const intPart = padded.slice(0, pointIndex).replace(/^0+(?=\d)/, '') || '0';
  const fracPart = padded.slice(pointIndex).replace(/0+$/, '');
  return sign + (fracPart ? `${intPart}.${fracPart}` : intPart);
};

/** Round a decimal STRING to `places` — BigInt half-up, no float. Display-only; never feed the result back into data. */
const roundDecimalString = (value: string, places: number): string => {
  const neg = value.startsWith('-');
  const [intRaw = '0', fracRaw = ''] = value.replace(/^[-+]/, '').split('.');
  if (fracRaw.length <= places) return value;
  const kept = BigInt(intRaw + fracRaw.slice(0, places)) + (fracRaw[places]! >= '5' ? 1n : 0n);
  const s = kept.toString().padStart(places + 1, '0');
  const intPart = s.slice(0, s.length - places) || '0';
  const fracPart = places > 0 ? s.slice(s.length - places) : '';
  return (neg ? '-' : '') + (fracPart ? `${intPart}.${fracPart}` : intPart);
};

const group = (value: string): string => {
  const [intPart, fracPart] = value.split('.');
  const grouped = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fracPart !== undefined ? `${grouped}.${fracPart}` : grouped;
};

/** Base unit → the human-scale unit a big figure reads in. The ONLY conversions this layer knows; anything else passes through untouched. */
const MAGNITUDE_UP: Record<string, string> = { g: 'kg', ml: 'l' };

/**
 * The display form of a quantity plus its exact stored form for a `title` attribute.
 * `369666.666662 g` reads as noise; `369.67 kg` reads as a fact — but the rounding is DISPLAY
 * only: the exact value stays inspectable on hover, so rounding for presentation never becomes
 * rounding in fact. The g→kg / ml→l conversion is a string decimal-point shift (÷1000 exactly),
 * applied once, here, at the render boundary — never implicit arithmetic mid-render (I6).
 * Unknown values never reach this function; the caller renders "Not known" instead.
 */
export const formatQuantityDisplay = (
  value: string | number,
  unitCode?: string | null
): { text: string; exact: string } => {
  const raw = String(value);
  const exact = unitCode ? `${raw} ${unitCode}` : raw;
  const bigUnit = unitCode ? MAGNITUDE_UP[unitCode] : undefined;
  const intDigits = raw.replace(/^[-+]/, '').split('.')[0]!.replace(/^0+/, '').length;
  if (bigUnit !== undefined && intDigits > 3) {
    const shifted = shiftDecimalPoint(raw, -3);
    return { text: `${group(roundDecimalString(shifted, 2))} ${bigUnit}`, exact };
  }
  return { text: formatQuantity(raw, unitCode), exact };
};

const DECIMAL_SHAPE = /^[-+]?(\d+\.?\d*|\.\d+)$/;

/** A decimal string as a scaled BigInt: '12.34' → { n: 1234n, scale: 2 }. Null when not a plain decimal. */
const toScaled = (value: string): { n: bigint; scale: number } | null => {
  const trimmed = value.trim();
  if (!DECIMAL_SHAPE.test(trimmed)) return null;
  const neg = trimmed.startsWith('-');
  const [intRaw = '0', fracRaw = ''] = trimmed.replace(/^[-+]/, '').split('.');
  const n = BigInt((intRaw || '0') + fracRaw);
  return { n: neg ? -n : n, scale: fracRaw.length };
};

const fromScaled = (n: bigint, scale: number): string => {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(scale + 1, '0');
  const intPart = s.slice(0, s.length - scale) || '0';
  const fracPart = scale > 0 ? s.slice(s.length - scale) : '';
  const joined = fracPart ? `${intPart}.${fracPart}` : intPart;
  return (neg ? '-' : '') + trimZeros(joined);
};

/**
 * Exact decimal arithmetic on STRINGS, for the few places a client must show a derived money
 * figure (a draft PO's preview total) before the server computes the authoritative one. BigInt
 * throughout — `Number('0.1') * 3` produces float dust, and a preview that disagrees with the
 * server's real total by a cent teaches the user not to trust either. Invalid input (a field
 * mid-edit: '', '2.') returns null; the caller decides how an incomplete draft line reads.
 */
export const multiplyDecimal = (a: string, b: string): string | null => {
  const sa = toScaled(a);
  const sb = toScaled(b);
  if (sa === null || sb === null) return null;
  return fromScaled(sa.n * sb.n, sa.scale + sb.scale);
};

export const addDecimal = (a: string, b: string): string | null => {
  const sa = toScaled(a);
  const sb = toScaled(b);
  if (sa === null || sb === null) return null;
  const scale = Math.max(sa.scale, sb.scale);
  const na = sa.n * 10n ** BigInt(scale - sa.scale);
  const nb = sb.n * 10n ** BigInt(scale - sb.scale);
  return fromScaled(na + nb, scale);
};

export const formatMoney = (amount: string | number, currency?: string | null): string => {
  const [intPart, fracRaw = ''] = String(amount).split('.');
  const grouped = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // Trailing zeros go, but never below two places — and real sub-cent precision (a 0.0010 unit
  // cost) is kept rather than rounded into a different number.
  const fracTrimmed = fracRaw.replace(/0+$/, '');
  const frac = (fracTrimmed + '00').slice(0, Math.max(2, fracTrimmed.length));
  const display = `${grouped}.${frac}`;
  return currency ? `${currency} ${display}` : display;
};
