// Only exceptions to the ISO 4217 2-decimal default are listed. A currency gaining or losing
// decimals is a reform needing a data migration of existing minor amounts, not a constant bump.

// Minor unit 0 — the amount IS the major unit; a "cents" division would inflate every price 100x.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'isk', 'jpy', 'kmf', 'krw', 'pyg', 'rwf',
  'ugx', 'uyi', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

const THREE_DECIMAL_CURRENCIES = new Set([
  'bhd', 'iqd', 'jod', 'kwd', 'lyd', 'omr', 'tnd',
]);

// ISO 4217 alphabetic codes are exactly three letters. Reserva stores and compares them lowercase
// (matching what payment providers and `Intl.NumberFormat` both accept), so the schema below is the
// one place that decides what a well-formed code looks like.
export const CURRENCY_CODE_PATTERN = /^[a-z]{3}$/;

export function isCurrencyCode(value: string): boolean {
  return CURRENCY_CODE_PATTERN.test(value);
}

// How many minor units make one major unit of `currency`. Every hard-coded `/ 100` in Reserva goes
// through here instead, so a zero-decimal deployment (JPY) cannot render a price 100x too small.
export function minorUnitFactor(currency: string): number {
  const code = currency.toLowerCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 1;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 1000;
  return 100;
}

// The number of fraction digits `minorUnitFactor` implies — what a manual (non-Intl) fallback needs
// to print an amount without inventing decimals a currency doesn't have.
export function minorUnitDigits(currency: string): number {
  return Math.log10(minorUnitFactor(currency));
}

export function toMajorUnits(amountMinor: number, currency: string): number {
  return amountMinor / minorUnitFactor(currency);
}
