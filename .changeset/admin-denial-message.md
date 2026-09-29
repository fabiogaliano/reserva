---
'@reservajs/astro': patch
---

A refused `/booking/admin` request now answers `403 forbidden` with "Admin authorization required" instead of "Cloudflare Access authorization required", which was wrong for a deployment signing in with its own `adminAuth`. It matches the message `/api/booking/ops/health` already used.
