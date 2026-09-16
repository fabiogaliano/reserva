---
"@reservajs/astro": minor
---

Add an **Opening hours** tab to the admin settings page. Each service's schedule rules expose their first and last departure as editable `HH:MM` settings (`services.<slug>.schedule.<index>.firstStart` / `.lastStart`), stored as overrides like every other setting and validated so the first departure never lands after the last. A stored hours row that a later config edit makes invalid is now dropped on its own instead of discarding every override.

`firstStart` and `lastStart` on a schedule rule are now optional and default to `09:00` and `18:00`.
