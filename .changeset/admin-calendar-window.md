---
'@reservajs/astro': patch
---

The admin's availability calendar now shows four months at a time instead of rendering every day of the booking horizon (up to 500) on each load. The month pager's arrows load the neighbouring months when they reach either end, and "Earlier months" / "Later months" links do the same without JavaScript. With the message catalog and date and price formatters also reused across requests, an admin page load uses roughly a quarter of the CPU it did.
