---
'@reservajs/astro': patch
---

The admin's availability calendar now shows three months at a time, with "Earlier months" / "Later months" links to page through the rest of the booking horizon, instead of rendering every day of the horizon (up to 500) on each load. With the message catalog and date and price formatters also reused across requests, an admin page load uses roughly a quarter of the CPU it did.
