# Deploying on Cloudflare

Everything between a working local config and a production Worker: secrets, typed bindings,
admin access, the runbook, the scheduled reconciliation Worker, and how Reserva's migrations
sit next to your own.

## Secrets and `astro:env`

`reserva()` declares its own secret names — and only its own — in Astro's
[`env.schema`](https://docs.astro.build/en/guides/environment-variables/#type-safe-environment-variables)
as `envField.string({ context: 'server', access: 'secret', optional: true })`:

| Declared name | Used by | Set with |
| --- | --- | --- |
| `RESERVA_OPERATOR_SECRET` | operator endpoints (bearer auth) | `wrangler secret put RESERVA_OPERATOR_SECRET` |
| `RESERVA_CSRF_SECRET` | the admin CSRF token layer | `wrangler secret put RESERVA_CSRF_SECRET` |
| `RESERVA_TOKEN_ENC_KEY` | manage-link token encryption | `wrangler secret put RESERVA_TOKEN_ENC_KEY` |

Provider credentials (`STRIPE_*`, `BREVO_API_KEY`, `GOOGLE_SA_*`) are not declared here: Reserva
cannot know which adapters a deployment wires up, and a site that uses only Stripe should not
carry names for Brevo and Google. Add the ones you use to your own `env.schema` if you want typed
access to them; adapters receive their credentials as constructor options from your runtime module
either way.

Every entry is optional because each one enables a layer rather than gating startup. `secrets()`
still exposes a closed allowlist: Reserva's own `RESERVA_*` names, every
`config.webhooks[].secretBinding`, and whatever `secretBindings` adds. Pass `envSchema: false` to
skip the contribution if your project declares its own schema for these names.

## Typed environment bindings

Run `wrangler types` to generate `worker-configuration.d.ts` from your `wrangler.jsonc`,
wired as a `pretypes`/`predev` script so it stays current:

```json
{ "scripts": { "pretypes": "wrangler types --include-runtime=false", "predev": "wrangler types --include-runtime=false" } }
```

`--include-runtime=false` matters for a site with client scripts: the default output also declares
the whole workerd runtime as globals, which shadow the DOM lib.

`wrangler types` emits a **global** `interface Env`, so pass it as the type argument with no
import: `defineCloudflareReservaRuntime<Env>({ … })`. The `providers` and `logger` factories then
receive a typed `env`, and the `db`, `cache`, and `secretBindings` options are constrained to
`keyof Env`, so a misspelled binding is a compile error. The type argument is optional. Set
`cache: null` to disable caching entirely.

`reserva()` also calls `injectTypes()`, so after `astro sync` (run implicitly by `astro dev`
and `astro build`) `virtual:reserva/runtime` is typed as `ReservaRuntime` and
`virtual:reserva/config` as `ReservaVirtualConfig` (`{ config, routes: { paths, groups, dev } }`).

## Admin access and booking tokens

Two unrelated mechanisms control who can do what.

**The admin dashboard and operator routes are gated by the `adminAuth` port.**
`defineCloudflareReservaRuntime` takes
`adminAuth?: (request, context) => Promise<{ subject: string; email?: string } | null>`:
`null` means 403, any other value is the caller's identity, used as-is. Every admin/ops
handler goes through one shared gate, so it is fail-closed by construction: an absent
`adminAuth`, one that resolves `null`, and one that throws all deny the same way. While the
admin or ops routes are enabled, the runtime validates at startup that exactly one admin-auth
path is configured — either `config.admin.access` or a custom `adminAuth`, not neither, not
both.

Cloudflare Access is the default implementation, wired automatically when
`config.admin.access = { teamDomain, aud }` is set. Access is a one-time manual setup in the
Cloudflare dashboard: create a Zero Trust team (its name becomes
`https://<team>.cloudflareaccess.com`, your `teamDomain`), add a self-hosted Access
application covering your production hostname's `booking/admin` path, attach a policy, and
copy the application's Audience tag into `aud`. Reserva independently verifies the forwarded
`Cf-Access-Jwt-Assertion` header (signature against the team's JWKS, issuer, audience), so a
request that reaches the Worker without passing Access — a raw `workers.dev` URL, a
misconfigured route — still gets 403.

Access cannot protect `localhost`, so `astro dev` bypasses the gate for you: when
`config.admin.access` is set and the build came from `astro dev`, the admin and operator routes
resolve the identity `{ subject: 'dev' }` without calling Access, and the runtime logs
`admin auth bypassed: astro dev` once per isolate. There is nothing to configure and nothing to
swap out at cutover. The flag behind it (`routes.dev` in `virtual:reserva/config`) is written at
build time from Astro's own command, never read from the environment, so `astro build` and
`astro preview` output always calls Access. A custom `adminAuth` is never bypassed — in dev or
anywhere else, its author owns what it lets through.

**Admin mutations also carry same-origin CSRF protection.** `adminAuth` answers who is
calling, not where the request came from, so Reserva enforces two independent layers before
any admin action: a Fetch-Metadata/Origin check (`Sec-Fetch-Site` must be `same-origin` —
`same-site` is rejected too, since an Access cookie is commonly scoped to the whole apex —
otherwise `Origin` must match; a POST with neither header is rejected), and a signed, expiring
CSRF token in every rendered admin form.

The token layer needs a `RESERVA_CSRF_SECRET` Worker secret
(`wrangler secret put RESERVA_CSRF_SECRET`). Without it there is
nothing fit to sign with, so the token layer goes offline rather than emitting a token that
only looks signed, and admin POSTs rely on the origin check alone. The token binds to the
identity `adminAuth` resolved. This is belt and braces, not a substitute for the Access
application's own cookie settings: in the Zero Trust dashboard set the cookie's SameSite to
`Lax` or `Strict` (Cloudflare's default is `None`, which a Worker cannot override).

**The manage page is gated by per-booking bearer tokens.** Every booking gets two random
tokens at creation: a `cancelToken` (in the customer's confirmation email link) and an
`operatorToken` (shown only in the admin page's manage links). Both open
`/booking/manage?token=…`; the page resolves the token kind and renders the matching role.
The customer role cancels and reschedules within the configured cutoffs and never controls
refunds; the operator role cancels with a refund choice, reschedules any confirmed booking,
and marks no-shows. A customer token's blast radius is its own booking; the admin page never
renders cancel tokens.

**Tokens are hashed at rest, expire, and the customer one is revoked on cancellation.** Only
`SHA-256(token)` is stored, both tokens share an expiry (default 60 days past the booking's
end; `config.booking.tokenExpiryDays` overrides), and an expired or revoked token gets the
exact same 403 as an unknown one. The operator token survives cancellation so a stuck refund
can still be resumed. Because emails and the admin page render manage links from a fresh D1
read, a hash alone cannot regenerate a link: set an optional `RESERVA_TOKEN_ENC_KEY` Worker
secret to also AES-GCM-encrypt each token so those reads can produce working links. Without
it, everything still works except link regeneration (links are omitted rather than rendered
dead). The key must be set before a booking is created for that booking's link to ever be
regenerable — a row written without it never has its plaintext at rest again.

## Setup runbook

1. **Apply the migrations.** `bunx reserva-migrate --local` for the local dev database,
   `bunx reserva-migrate` for the remote one. The command reads your Wrangler config, selects
   a D1 entry (the `RESERVA_DB` binding, a sole `d1_databases` entry, or the entry matching an
   optional positional name), and points Wrangler at Reserva's packaged `migrations/`
   directory by writing a derived config beside your own and running
   `wrangler d1 migrations apply` against it. If the entry already sets `migrations_dir` to
   something else, the command refuses with an error naming both paths — see
   [Reserva and your own migrations](#reserva-and-your-own-migrations). It accepts Wrangler's
   migration options (`--env`, `--config`, `--remote`, `--preview`, `--persist-to`, …); use
   `--` to pass anything else through verbatim. At the first request in each isolate, the
   runtime checks the migrations and throws a descriptive error naming any unapplied one. If
   your binding sets Wrangler's `migrations_table`, pass the same name as `migrationsTable` to
   `defineCloudflareReservaRuntime`.
2. Set `RESERVA_DB` in the Worker bindings. Optionally expose `RESERVA_CACHE`.
3. Add payment, calendar, email, and webhook credentials as Worker secrets with
   `wrangler secret put <NAME>`; see [Secrets and `astro:env`](#secrets-and-astroenv) for the
   canonical names. With `@reservajs/stripe`, subscribe the webhook endpoint to
   `checkout.session.completed`, `checkout.session.expired`,
   `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`,
   `charge.refunded` and `charge.dispute.created`, and manage payment methods in the Stripe
   dashboard. **Reserva does not support delayed payment methods. Do not enable Multibanco, SEPA
   Direct Debit, or bank transfer in the Stripe dashboard** — their money arrives days after the
   capacity hold expires. One enabled by mistake is refused at the webhook (hold released, payment
   cancelled, customer told) and refunded in full if it settles anyway. Set the webhook endpoint's
   API version explicitly rather than leaving it on the account default: the event payload's shape
   follows the endpoint's version, so an account default that moves can change the fields the
   adapter reads with no deploy on your side.
4. Run `wrangler types` and pass its global `Env` to `defineCloudflareReservaRuntime<Env>()` (no import).
5. Implement or import the provider adapters in the runtime module.
6. Configure an admin auth strategy: Cloudflare Access matching `config.admin.access`, or a
   custom `adminAuth`. The runtime throws at startup if neither (or both) is configured while
   the admin/ops routes are enabled. `astro dev` output bypasses Access automatically; a
   production build never does.
7. **Set `RESERVA_TOKEN_ENC_KEY` before the first booking.** It encrypts the manage/operator
   tokens at rest. It cannot be rotated once bookings exist: every manage link minted under the
   old key stops resolving. Without it Reserva stores the tokens in clear text and the admin
   dashboard shows a warning card.
8. **Set `RESERVA_CSRF_SECRET`.** It signs the admin dashboard's CSRF tokens. Without it that
   layer is inert (the origin check still runs) and the dashboard shows a warning card.
   `GET /api/booking/ops/health` reports both under `security`.
9. Deploy with `output: 'server'` and `@astrojs/cloudflare`. Do not prerender booking routes.
10. **Ship `scheduled` in the site Worker.** Reconciliation is a bounded sweep that resumes stuck
   side-effect and refund debt, clears expired holds, and opens or resolves operator incidents —
   the outage-survival backstop behind the "Attention required" cards on `/booking/admin`.
   `@astrojs/cloudflare` honours a custom `main` in your `wrangler.jsonc`, so the cron lives in the
   same Worker as the site and shares its bindings and secrets. Add one file:

   ```ts
   // src/worker.ts
   import { handle } from '@astrojs/cloudflare/handler';
   import { scheduledHandler } from '@reservajs/astro/runtime';
   import runtime from './reserva-runtime';

   export default {
     fetch: handle,
     scheduled: scheduledHandler(runtime),
   };
   ```

   No `satisfies ExportedHandler<Env>`: that type comes from the workerd globals, whose `Request`
   conflicts with the DOM `Request` an Astro project with client scripts compiles against.

   and point Wrangler at it:

   ```jsonc
   {
     "main": "./src/worker.ts",
     "triggers": { "crons": ["*/5 * * * *"] }
   }
   ```

   Five minutes is the documented cadence (`RECONCILIATION_CADENCE_MINUTES`); ops health opens a
   `reconciliation_stale` incident once the last successful run is older than three ticks.

   `scheduledHandler` rethrows on failure, so a bad run is recorded as a failed cron invocation. An overlapping invocation takes no work: both it and
   `POST /api/booking/ops/reconcile` compete for one D1 lease row, and the loser logs a warning and
   exits successfully. Pass `ReconciliationOptions` as the second argument to change the limits, or
   call `runReconciliationWithLease(context, options)` yourself if you need to do more in the same
   invocation.

   `POST /api/booking/ops/reconcile` runs the same sweep on demand, authorized by the operator
   bearer secret or an admin identity. It takes an optional JSON body with `sourceLimit` and
   `alertLimit`, returns the `ReconciliationSummary`, answers `409 reconciliation_in_progress` when
   the lease is held.
   `GET /api/booking/ops/health` reports `reconciliation.lastRunAt` and the last summary.

   **The operational alert sink.** Alerts are what tell you an incident opened without you watching
   the dashboard. Reserva ships one: `emailAlertSink(email, { to })`, which renders through the same
   branded email shell as booking mail and sends through the email provider's `sendMessage`. You do
   not normally construct it — when `providers.alerts` is absent and `providers.email` implements
   `sendMessage` (the shipped Brevo adapter does), the runtime wires it to
   `business.contact.email` and logs `reserva operational alerts wired to the email provider` once.
   Without such a provider the runtime wires `loggerAlertSink` instead and warns once: alerts then
   land in the Worker logs only. Pass `providers.alerts` explicitly to override the mailbox or the
   channel. If email is down the incident still shows on `/booking/admin`.

   Enable Workers observability with full logs, and set up a Cloudflare-side alert on cron failures
   before go-live: the in-process alert sink only fires from inside an invocation, so the platform
   alert is the independent detection path when the trigger itself fails.
11. In a staging Worker, verify availability, checkout holds, webhook redelivery, status
   confirmation, cutoffs, operator actions, and admin authentication.
12. Monitor the outbox and payment-webhook responses. Calendar and confirmation-email failures
    intentionally return non-2xx so the payment provider retries delivery. Also alert on
    persistent `confirmation_in_progress` 503s (a stuck lease), on `payment_amount_mismatch`
    409s (never expected in normal operation), and on the "confirming expired hold after
    payment" warning, which marks a possible one-slot oversell.

## Rebuilding a static site on admin changes

The admin dashboard is the source of truth for prices, hours, capacity and policy. A static site
that bakes those values at build time therefore has to rebuild when an operator saves. Reserva
fires `settings.changed` once per admin save (settings, day overrides, capacity defaults); point a
webhook at your build system and have the build read `/api/booking/catalog` for the live values:

```ts
webhooks: [{
  name: 'rebuild',
  url: '<your deploy hook URL>',
  secretBinding: 'REBUILD_WEBHOOK_SECRET',
  events: ['settings.changed'],
}]
```

The webhook is a POST with the Standard Webhooks signature headers and nothing else: no
`Authorization` header, no custom body. So it can call a receiver that needs no auth, and cannot
call GitHub or a CI API directly. Two receivers work:

- **A Cloudflare Workers Builds deploy hook.** Accepts the POST as-is, rate-limited to 10 builds
  per minute per Worker. Anyone who learns the URL can trigger a build.
- **A relay Worker.** Verify the `webhook-*` headers with any Standard Webhooks library, then call
  GitHub `repository_dispatch` (or your CI's equivalent) with a token the public never sees. Needed
  whenever the build runs from GitHub Actions.

A hook that arrives while a build is still `queued`/`initializing` is deduplicated, not queued —
which is safe, because that build has not fetched the catalog yet. A save during a *running* build
queues a new one. So consecutive saves do not guarantee consecutive builds, but the last build to
run always reads the latest catalog.

Delivery is best-effort by design: three attempts (2 s, 8 s), then
`logger.error('settings webhook delivery failed', { name, status })` and no incident row. If a
rebuild is missed, save again or deploy by hand.

## Reserva and your own migrations

Reserva shares Wrangler's migration ledger (`d1_migrations` by default) with any migrations of
your own applied to the same database; Wrangler has no per-package namespaces. The supported
layout is a dedicated D1 database for Reserva. If you do share one, do not name a migration of
your own `0001_init.sql`, which is the whole of Reserva's schema: a colliding filename satisfies
the ledger check without creating that schema. The runtime
layers a schema fingerprint on top of the filename check and throws a distinct error naming
the likely collision when the ledger and the schema disagree. This is collision detection, not
a fix.
