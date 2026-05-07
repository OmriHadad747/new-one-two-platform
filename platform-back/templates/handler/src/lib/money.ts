/**
 * Currency-aware money helper.
 *
 * Money is stored as integer minor units in BIGINT columns. This module
 * is the only correct way to convert between Shopify's decimal-string
 * payloads and stored integers — `Math.round(parseFloat(x) * 100)` is
 * silently wrong for zero-decimal currencies (JPY, KRW) and three-
 * decimal currencies (BHD, JOD).
 *
 * The decimals table lists every ISO 4217 currency whose minor-unit
 * count differs from 2. Anything not listed defaults to 2 — which is
 * correct for the ~150 currencies Shopify supports (USD, EUR, GBP, …).
 * Unknown codes are logged once via console.warn so operators can spot
 * a missing entry; the helper itself does not throw on unknown codes.
 */

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "MGA",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

const THREE_DECIMAL_CURRENCIES = new Set([
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
]);

const _warnedUnknown = new Set<string>();

const CURRENCY_CODE_RE = /^[A-Za-z]{3}$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export interface CurrencyMeta {
  code: string;
  decimalDigits: 0 | 2 | 3;
}

function normalizeCurrency(code: string): string {
  if (typeof code !== "string" || !CURRENCY_CODE_RE.test(code)) {
    throw new MoneyError(`invalid currency code: ${JSON.stringify(code)}`);
  }
  return code.toUpperCase();
}

function decimalsFor(code: string): 0 | 2 | 3 {
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

function warnUnknown(code: string): void {
  if (_warnedUnknown.has(code)) return;
  _warnedUnknown.add(code);
  // Logged once per process per code — we don't want to spam logs on a
  // hot path but we DO want operators to notice an unfamiliar currency.
  console.warn(
    JSON.stringify({
      event: "money.unknown_currency_default_2",
      currency: code,
      message: "currency not in helper table; defaulting to 2 decimals",
    }),
  );
}

/**
 * Look up currency metadata. Used by callers that need to know the
 * minor-unit count without performing a conversion.
 */
export function currency(code: string): CurrencyMeta {
  const normalized = normalizeCurrency(code);
  const digits = decimalsFor(normalized);
  if (digits === 2 && !_isKnownTwoDecimal(normalized)) {
    warnUnknown(normalized);
  }
  return { code: normalized, decimalDigits: digits };
}

// We don't keep an explicit list of every two-decimal currency (~150
// entries) — anything not in the zero/three sets defaults to 2. The
// "known" check is for the warn path: any code outside our explicit
// sets fires a one-time warning, which is what we want for surfacing
// new Shopify currencies without polluting steady-state logs.
function _isKnownTwoDecimal(_code: string): boolean {
  return false;
}

/**
 * Convert a Shopify-shaped decimal string (e.g. "9.99", "100", "1.234")
 * into an integer count of minor units for the given currency.
 *
 * - USD "9.99"     → 999
 * - JPY "100"      → 100      (zero-decimal: 1 yen IS the minor unit)
 * - BHD "1.234"    → 1234     (three-decimal: thousandths of a dinar)
 *
 * Rounding is `Math.round` (nearest, ties away from zero) — locked to
 * one policy so different recipes can't drift. Sign is preserved
 * (refunds, adjustments).
 */
export function toMinorUnits(value: string | number, code: string): number {
  if (value === null || value === undefined) {
    throw new MoneyError("missing value");
  }
  const normalized = normalizeCurrency(code);
  const digits = decimalsFor(normalized);
  if (digits === 2 && !_isKnownTwoDecimal(normalized)) {
    warnUnknown(normalized);
  }

  // Reject exotic numeric forms — Shopify never sends scientific notation,
  // localized separators, or whitespace. Accepting them would mask bugs.
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new MoneyError("invalid number: empty string");
    }
    if (/[eE]/.test(value)) {
      throw new MoneyError(`invalid number: scientific notation not supported (${value})`);
    }
    if (/[,\s]/.test(value)) {
      throw new MoneyError(`invalid number: localized separators not supported (${value})`);
    }
  }

  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new MoneyError(`invalid number: ${JSON.stringify(value)}`);
  }

  const factor = digits === 0 ? 1 : digits === 3 ? 1000 : 100;
  return Math.round(num * factor);
}

/**
 * Inverse of toMinorUnits — convert an integer minor-unit amount back
 * to a decimal number for display or downstream APIs that take decimal
 * money. Rare in practice; recipes typically store integers and never
 * reconstruct the decimal.
 */
export function fromMinorUnits(amount: number, code: string): number {
  if (!Number.isInteger(amount)) {
    throw new MoneyError(`amount must be an integer, got ${amount}`);
  }
  const normalized = normalizeCurrency(code);
  const digits = decimalsFor(normalized);
  const factor = digits === 0 ? 1 : digits === 3 ? 1000 : 100;
  return amount / factor;
}

/**
 * Format an integer minor-unit amount as a plain decimal string with
 * the correct digit count for the currency. No symbol, no grouping —
 * use formatLocalized (Phase 2) for user-facing strings.
 */
export function format(amount: number, code: string): string {
  if (!Number.isInteger(amount)) {
    throw new MoneyError(`amount must be an integer, got ${amount}`);
  }
  const normalized = normalizeCurrency(code);
  const digits = decimalsFor(normalized);
  if (digits === 0) {
    return String(amount);
  }
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const factor = digits === 3 ? 1000 : 100;
  const whole = Math.trunc(abs / factor);
  const frac = abs % factor;
  return `${sign}${whole}.${String(frac).padStart(digits, "0")}`;
}

/**
 * Sum integer minor-unit amounts. Use this instead of `arr.reduce`/`+`
 * so the intent is explicit and float math can never sneak in.
 */
export function sum(amounts: readonly number[]): number {
  let total = 0;
  for (const a of amounts) {
    if (!Number.isInteger(a)) {
      throw new MoneyError(`sum: amount must be an integer, got ${a}`);
    }
    total += a;
  }
  return total;
}

/**
 * Apply a percentage to an integer minor-unit amount.
 *
 *   percentage(1000, 8.5)  // 8.5% of 10.00 → 85
 *
 * Rounded to the nearest minor unit. Use for tax, discount, fee math —
 * never `amount * pct / 100`.
 */
export function percentage(amount: number, pct: number): number {
  if (!Number.isInteger(amount)) {
    throw new MoneyError(`percentage: amount must be an integer, got ${amount}`);
  }
  if (!Number.isFinite(pct)) {
    throw new MoneyError(`percentage: pct must be finite, got ${pct}`);
  }
  return Math.round((amount * pct) / 100);
}
