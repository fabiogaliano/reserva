---
"@reservajs/astro": minor
---

Single config source: the integration validates `reserva.config.ts` once and ships the result through `virtual:reserva/config`, which is now `{ config: ResolvedClientConfig, routes: { paths, groups, dev } }`. `defineCloudflareReservaRuntime(options)` and `defineReservaRuntime(options)` drop their config argument and read it from there, so a runtime module no longer imports (or re-validates) the config file — `reserva.config.ts` is imported only by `astro.config.ts`. `routes.dev` is `true` only in `astro dev` output.

Breaking: `ServiceConfig.occupancyFor` is replaced by `occupancy: { seatsPerUnit }` (units are `ceil(quantity / seatsPerUnit)`); a function value is now a validation error naming the replacement, and the resolved config is JSON-serializable as a result. `runtimeEntrypoint` is optional and defaults to `./src/reserva-runtime.ts` resolved against the project root (a missing file still throws with the resolved path). `reservaSecretEnvSchema` keeps `RESERVA_OPERATOR_SECRET`, adds `RESERVA_CSRF_SECRET` and `RESERVA_TOKEN_ENC_KEY`, and no longer declares `STRIPE_*`, `BREVO_*` or `GOOGLE_*` — declare the provider names you want typed access to in your own `env.schema`. A consumer reading route paths moves from `routeConfig.paths.x` to `virtualConfig.routes.paths.x`. See `docs/MIGRATING-v2.md` for the 0.5.0 steps.
