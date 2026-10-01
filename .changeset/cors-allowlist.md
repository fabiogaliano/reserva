---
'@reservajs/astro': minor
---

A booking funnel on another site can now call the customer API from the browser. List its origins in `routes.cors.origins` (exact origins such as `https://www.example.com`; a path, trailing slash or wildcard fails the build), and the `availability`, `checkout`, `quote`, `catalog`, `status`, `manageApi`, `cancel` and `reschedule` routes answer the preflight and send `Access-Control-Allow-Origin` to those origins. Admin, operator, ops and webhook routes never do. Without `routes.cors`, no route sends CORS headers, as before.
