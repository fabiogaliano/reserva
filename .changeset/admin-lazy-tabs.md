---
'@reservajs/astro': patch
---

The admin dashboard now loads and renders only the tab being shown. Each tab was built on every page load — the bookings list, the availability calendar, the partner counts and the incident history — with its own database queries and markup, whichever one was on screen. Switching tabs is now an ordinary page load, and a dashboard load uses about half the CPU it did.
