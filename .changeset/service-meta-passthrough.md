---
"@reservajs/astro": minor
---

`meta` passthrough on services and meeting points: an opaque JSON object reserva stores, size-checks and echoes back on the catalog, but never reads. It is where a site keeps the content that belongs to a service but is not a booking rule (hero image, tagline, a meeting point's coordinates), so a static build fetches prices and content in one call instead of maintaining a parallel file keyed by slug. Values must be JSON-serializable and each object must stay under 8 KB. `CatalogService.meta` and `CatalogMeetingPoint.meta` are always present, `{}` when the config declares none.
