---
'@reservajs/astro': patch
'@reservajs/stripe': patch
---

Rewrote the README, `AGENTS.md` and the shipped docs to be shorter and plainer, and brought them up to date with partners, referral codes, CORS and the hold cap. `docs/MIGRATING-v2.md` is no longer shipped. The Stripe README's setup example no longer passes `config` to `defineCloudflareReservaRuntime`, which stopped taking it in 0.5.0.
