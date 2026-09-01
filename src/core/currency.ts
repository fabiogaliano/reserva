// Prices are stored and transported in a currency's *minor* unit
// (`Booking.priceMinor`), so every place that renders or divides an amount needs to know how many
// minor units make one major unit. That is a property of ISO 4217, not of any payment provider —
// the core owns it, and a provider adapter narrows it to whatever set that provider supports.
//
// Source: ISO 4217 (2024 edition) currency-and-funds register, "minor unit" column, as republished
// by the Six Group maintenance agency. Only the exceptions to the 2-decimal default are listed;
// everything else (including every code not listed at all) is 2.
//
// The registry is not versioned in this file on purpose: a code that gains or loses decimals is a
// currency reform, which needs a considered data migration of existing minor amounts, not a silent
// constant bump.

// Minor unit 0 — the amount IS the major unit; a "cents" division would inflate every price 100x.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'isk', 'jpy', 'kmf', 'krw', 'pyg', 'rwf',
  'ugx', 'uyi', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

// Minor unit 3.
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

// Minor units -> the major-unit number a formatter takes.
export function toMajorUnits(amountMinor: number, currency: string): number {
  return amountMinor / minorUnitFactor(currency);
}
