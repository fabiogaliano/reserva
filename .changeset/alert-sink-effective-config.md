---
'@reservajs/astro': minor
---

Operational alerts now go to the `business.contact.email` saved on the admin settings page. They used to go to the address in `reserva.config.ts` even after an admin changed it. `OperationalAlertSink.send` now receives the effective config as a second argument; custom sinks that ignore it keep working, and direct callers of `emailAlertSink(…).send` must pass it.
