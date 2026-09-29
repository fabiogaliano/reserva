---
"@reservajs/astro": minor
---

A new admin tab lists every field with `adminBadge: true` (a partner, a sales channel): each option, even with no bookings yet, with its **Upcoming** count (confirmed bookings still ahead) and **Past** count (confirmed and no-show bookings whose start has passed). Each count opens the bookings list for that value. The tab is named after the field, or "Tags" when several fields are tagged, and doesn't appear when none is.

A select field can declare `adminOptionLink`, a URL with `{value}` in it, to show each option's link with a copy button on that tab, such as a partner's referral link.
