---
'@reservajs/astro': patch
---

Availability, the admin dashboard and every request now use a fraction of the CPU they did, so they fit a Cloudflare Worker's per-request budget (10 ms on the Free plan). Timezone conversions reuse the zone's offset per hour instead of asking `Intl` on every call, date and price formatters are created once and reused, availability builds a day's slots and the range's occupancy once instead of repeatedly, and the config is validated once per isolate instead of on every request. Results are unchanged, including across DST transitions.
