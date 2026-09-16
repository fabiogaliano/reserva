---
"@reservajs/astro": minor
---

`priceFor` picks the tightest covering tier regardless of row order, so an unsorted pricing array (a raw config module, a hand-built rule list) prices the same as `validateConfig`'s sorted output. `resolvedPriceTableFor` and `pricingCombinations` are now exported from `@reservajs/astro/core`, with `ResolvedPriceTable`, so a funnel builds a price grid from the catalog's rules instead of reimplementing breakpoint semantics. Documented in `docs/api.md`.
