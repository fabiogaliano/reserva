---
'@reservajs/astro': patch
---

Operational alerts are no longer silently dropped when a deployment has neither an email provider that can send a standalone message nor a configured logger. They now go to `console`, the same default the rest of Reserva logs to.
