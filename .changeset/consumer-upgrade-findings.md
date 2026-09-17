---
"@reservajs/astro": patch
---

Fixes from the first 0.5.0 consumer upgrade.

- `priceFor` and `resolvedPriceTableFor` accept catalog rows (`pickup: string | null`), so
  `resolvedPriceTableFor(catalog.services[i])` type-checks as documented.
- A deployment with no email provider that can send a standalone message now gets `loggerAlertSink`
  wired automatically, with a warning, instead of the cron refusing to run. `loggerAlertSink` is
  exported from `@reservajs/astro/runtime`.
- The catalog publishes `policy` (`cancelCutoffHours`, `reschedule.enabled`,
  `reschedule.cutoffHours`), so a static site can rebuild the policy it prints, not only prices.
- `pickupOptions[].label` is required in the `ClientConfig` type, matching the runtime rule.
- Docs: drop `satisfies ExportedHandler<Env>` from the worker snippet, recommend
  `wrangler types --include-runtime=false`, state that the settings webhook cannot call GitHub
  without a relay, and use the current `/cdn-cgi/handler/scheduled` cron trigger in the smoke site.
