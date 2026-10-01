---
'@reservajs/astro': minor
---

`booking.maxHoldsPerIp` now defaults to `5`. Every unpaid hold blocks capacity for at least `holdMinutes`, and without a cap one script could hold a whole day. A sixth concurrent checkout from the same IP answers `429 too_many_holds`. Raise the value where many customers share one IP, or set `maxHoldsPerIp: null` to keep the old unlimited behaviour. Clearing the field on the admin settings page now stores that `null`, so it stays off instead of falling back to the default.
