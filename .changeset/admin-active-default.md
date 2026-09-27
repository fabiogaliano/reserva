---
"@reservajs/astro": patch
---

The admin bookings list opens on a new "Active" filter: confirmed, awaiting payment and no-show bookings. Expired holds (abandoned checkouts) and cancellations no longer crowd the default view; "All" (`?status=all`) still lists every status. Sites that translate the admin into a locale other than en or pt-PT should add `admin.filterActive`.
