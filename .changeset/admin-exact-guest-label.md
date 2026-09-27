---
"@reservajs/astro": patch
---

The admin bookings list labels an exact guest count with its own `admin.guestCount` / `admin.guestCountOne` messages ("3 guests", "1 guest") instead of `widget.quantityCount`. A site that rewords `widget.quantityCount` as "Up to {n} guests" for its "up to N" tiers no longer gets "Up to 3 guests" as the tooltip and screen-reader text of a payer's exact answer. Sites that translate the admin into a locale other than en or pt-PT should add both keys.
