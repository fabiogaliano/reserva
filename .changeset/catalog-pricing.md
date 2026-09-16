---
"@reservajs/astro": minor
---

Publish pricing on the public catalog. Every service in `GET /api/booking/catalog` now carries `pricing` — its rules exactly as configured, each `{ maxQuantity, pickup, priceMinor }` with `pickup` null where the service has no pickup axis — and `fromPriceMinor`, the lowest price across those rules, for rendering a "from" price. Both are projected from the merged runtime config, so admin overrides flow through, and `CatalogService` (plus the new `CatalogPricingRule`) is exported from `@reservajs/astro/core`.

A site can now render prices from the engine instead of keeping its own copy. The catalog still never exposes schedules, turnaround, or capacity, and the amount charged still comes from `/api/booking/quote`.
