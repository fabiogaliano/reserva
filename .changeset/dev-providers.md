---
"@reservajs/astro": minor
---

Add `@reservajs/astro/dev`: `devProviders(options?)` returns in-memory payment, calendar, email and alert providers so `astro dev` runs the whole booking flow with no external account. Checkout redirects straight to the confirmation page and the session always reports paid; the email provider logs the customer and operator manage URLs and implements `sendMessage`. `devOutbox` (`{ emails, alerts }`) and `armNextCalendarFailure()` are exported for local assertions. Gate the import on `import.meta.env.DEV` so a production build tree-shakes it.
