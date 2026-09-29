// Constructing an Intl formatter loads locale data and costs far more than formatting with one: the
// admin built a new one per calendar day and per price, which alone exceeded a Worker's CPU budget.
// Formatters are immutable, so one per locale and options is reused for the isolate's lifetime. A
// constructor that throws (unknown zone or currency) caches nothing and throws as before.
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const numberFormats = new Map<string, Intl.NumberFormat>();
const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();

function cached<T>(cache: Map<string, T>, locale: string | undefined, options: object | undefined, create: () => T): T {
  const key = JSON.stringify([locale ?? null, options ?? null]);
  let formatter = cache.get(key);
  if (!formatter) {
    formatter = create();
    cache.set(key, formatter);
  }
  return formatter;
}

export function dateTimeFormat(locale?: string, options?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cached(dateTimeFormats, locale, options, () => new Intl.DateTimeFormat(locale, options));
}

export function numberFormat(locale?: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  return cached(numberFormats, locale, options, () => new Intl.NumberFormat(locale, options));
}

export function relativeTimeFormat(locale?: string, options?: Intl.RelativeTimeFormatOptions): Intl.RelativeTimeFormat {
  return cached(relativeTimeFormats, locale, options, () => new Intl.RelativeTimeFormat(locale, options));
}
