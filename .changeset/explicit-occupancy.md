---
'@reservajs/astro': minor
---

A service that sells parties larger than one must now declare `occupancy: { seatsPerUnit }`. Without it, a booking took one capacity unit whatever its size, so `capacity.default` silently counted bookings rather than people: the restaurant example's 40 covers admitted 320 diners per seating. Declare `seatsPerUnit` equal to the largest `maxQuantity` to keep the old one-unit-per-booking behaviour, or `1` to count people. The README quickstart and the example configs now declare it.

Availability now counts the units stored with each booking, the same number the atomic capacity check sums. It used to recompute them from the current `seatsPerUnit`, so after a change the two disagreed, and concurrent checkouts could pass both and overbook the slot. Bookings made before a `seatsPerUnit` change keep their old units in both until re-counted; the migration notes give the one-line re-count.

See "Migrating to 0.16.0" in docs/MIGRATING-v2.md.
