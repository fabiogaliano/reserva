---
"@reservajs/astro": minor
---

Add `@reservajs/astro/client`: a browser-safe, typed API client. `createReservaClient({ paths | base, fetch, bearer })` covers catalog, availability, quote, checkout, status, manage, cancel, reschedule, the operator routes, `opsHealth` and `opsReconcile`, with every failure — envelope, bare non-2xx or network error — surfaced as a `ReservaApiError` carrying `status`, `code` and `details` (`isReservaApiError` narrows it). The entry imports only the wire types, `API_ERROR_CODES` and a new Astro-free route pattern table (`src/core/route-paths.ts`, now the single source `routes-manifest.ts` builds on), so it pulls no Astro, Node or Cloudflare code into a bundle.
