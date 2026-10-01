---
'@reservajs/astro': minor
---

A service that sells parties larger than one must now declare `occupancy: { seatsPerUnit }`. Without it, a booking took one capacity unit whatever its size, so `capacity.default` silently counted bookings rather than people: the restaurant example's 40 covers admitted 320 diners per seating. Declare `seatsPerUnit` equal to the largest `maxQuantity` to keep the old one-unit-per-booking behaviour, or `1` to count people. The README quickstart and the example configs now declare it.

See "Migrating to 0.16.0" in docs/MIGRATING-v2.md.
