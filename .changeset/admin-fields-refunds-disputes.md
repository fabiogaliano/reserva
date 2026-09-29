---
"@reservajs/astro": minor
---

The admin dashboard shows declared fields, refunds and disputes.

- A booking's details list every declared metadata field it has a value for, after the price and in the admin locale, including operator-only fields and on cancelled and no-show bookings, which have no manage link.
- Fields with `adminBadge: true` tag the booking in the bookings list and the calendar day panel with the option's label, and the raw value once that option is gone.
- A "Refunded €X" badge and a "Dispute open / won / lost" badge sit beside the status. The details gain matching "Refunded" and "Dispute" rows, with the date the dispute opened.
- Search matches a select field by the option label it shows, not only by the stored value.
