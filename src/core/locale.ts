// A bare language tag (from `navigator.language`, `Accept-Language`, or a URL segment) resolves
// against `locales.supported` via longest-prefix BCP 47 subtag matching, ties to declaration
// order — always a canonical supported tag, never a client-supplied one.

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
