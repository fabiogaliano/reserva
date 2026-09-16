---
"@reservajs/astro": patch
---

Tighten four database hot spots. The admin list now reads `listUpcoming(now, { untilDays: 90,
limit: 500 })` with a "Show later bookings" link (`?until=180`) and the same cap on the filtered
`listAllFrom` path, and cancel/operator tokens are decrypted only for the rows the page actually
emits. `listOccupancyBookings` selects the seven columns the occupancy math reads instead of every
booking column, and returns the narrowed `OccupancyBooking` shape. Booking creation inserts with
`ON CONFLICT(reference) DO NOTHING` and regenerates the reference on conflict (max 5 attempts),
dropping the per-candidate pre-read. `runReconciliation` now loops candidate batches until a short
batch or 20 s of wall clock, and its summary reports `batches`.
