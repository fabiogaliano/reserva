// Plan 027 (design decision 5): locale negotiation belongs to the library, not to every consumer.
// The first consumer shipped its own `'pt'` -> `'pt-PT'` shim because a bare language tag — which
// is what a browser's `navigator.language`, an `Accept-Language` header, or a URL segment usually
// carries — matched nothing in `locales.supported` and was rejected outright.
//
// The rule is longest-prefix matching over BCP 47 subtags, case-insensitively: the supported tag
// sharing the most leading subtags with the request wins, ties go to the earlier-declared tag (so
// `locales.supported` order is the deployment's preference order), and a request sharing not even
// a primary language subtag falls back to `locales.default`. The value returned is always one of
// the declared supported tags, verbatim, so downstream storage and copy lookups see a canonical
// value and never a client-supplied one.

export interface LocaleNegotiationConfig {
  supported: readonly string[];
  default: string;
}

function subtags(tag: string): string[] {
  return tag.toLowerCase().replace(/_/g, '-').split('-');
}

export function resolveLocale(locales: LocaleNegotiationConfig, requested: string | null | undefined): string {
  if (!requested) return locales.default;
  const wanted = subtags(requested);
  let best: { locale: string; score: number } | undefined;
  for (const candidate of locales.supported) {
    const parts = subtags(candidate);
    let score = 0;
    while (score < parts.length && score < wanted.length && parts[score] === wanted[score]) score += 1;
    // A shared primary language subtag is the minimum for a match: `pt` and `pt-BR` both resolve to
    // a `pt-PT`-only deployment, while `de` resolves to nothing and takes the default.
    if (score === 0) continue;
    if (!best || score > best.score) best = { locale: candidate, score };
  }
  return best?.locale ?? locales.default;
}
