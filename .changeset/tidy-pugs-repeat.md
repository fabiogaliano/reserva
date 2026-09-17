---
"@reservajs/astro": patch
---

`reserva-migrate --remote` works again. The derived-config arguments added `--persist-to`
unconditionally, but that flag names a *local* persistence directory and wrangler rejects it under
`--remote` ("Cannot use --persist-to without --local"), so the documented way to migrate a
production database — runbook step 1, and any CI step that applies migrations before deploying —
failed every time. It is now omitted for a remote run; a local run still gets its own persistence
root so projects do not share one.
