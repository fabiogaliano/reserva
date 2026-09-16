---
"@reservajs/astro": patch
---

Docs and examples use the global `Env` that `wrangler types` emits, instead of importing it from `worker-configuration` — that file declares `interface Env` globally and exports nothing, so the documented import never compiled. `test:quickstart` now type-checks the assembled quickstart site against `wrangler types` output, so the README's runtime module cannot drift from what actually compiles.
