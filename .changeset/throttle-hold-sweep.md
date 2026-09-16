---
"@reservajs/astro": patch
---

The expired-hold sweep no longer runs an UPDATE on every availability and admin request: it is throttled to once per 60 seconds per isolate, with the reconciliation cron remaining the guarantee. Checkout drops its unconditional sweep and sweeps only when the hold insert reports a capacity conflict, so a just-expired hold still frees the slot immediately.
