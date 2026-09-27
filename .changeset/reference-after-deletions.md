---
"@reservajs/astro": patch
---

A new booking's reference now continues from the highest one used that year instead of counting rows. Deleting old bookings (test or abandoned ones) used to restart numbering inside the range already taken, so checkout collided with existing references and could fail after its retries.
