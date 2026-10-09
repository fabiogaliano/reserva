# Deploying on Cloudflare

Secrets, typed bindings, admin access, the setup checklist, the scheduled sweep, and how
Reserva's migrations sit next to your own.

## Which Workers plan

Reserva runs on the Workers Free plan. The limit that matters is D1's 50 queries per Worker
invocation (1,000 on Paid). After a calendar or email outage, the reconciliation sweep can owe
far more than that, so it only starts a step when the step's worst case still fits, and always
keeps enough queries to release its lease and send one alert. On Free, a tick delivers about
two owed side effects, and a large backlog drains over several five-minute ticks. Customer
requests that touch a booking also deliver its owed effects.

On Paid, raise the budget to drain it in one tick:
`scheduledHandler(runtime, { requireAlertSink: true, queryBudget: 900 })`. The default,
`DEFAULT_RECONCILIATION_QUERY_BUDGET`, is what's left of the Free cap after the schema check,
the settings read and the lease.

## Secrets

`reserva()` declares its own secrets in Astro's
[`env.schema`](https://docs.astro.build/en/guides/environment-variables/#type-safe-environment-variables),
all optional, because each one turns on a layer rather than being required to start:

| Secret | Turns on |
| --- | --- |
| `RESERVA_OPERATOR_SECRET` | bearer auth for the operator endpoints |
| `RESERVA_CSRF_SECRET` | CSRF tokens on admin forms |
| `RESERVA_TOKEN_ENC_KEY` | encrypting manage-link tokens, so emails and the admin can rebuild links |

Set each with `wrangler secret put <NAME>`. Provider credentials (`STRIPE_*`, `BREVO_API_KEY`,
`GOOGLE_SA_*`) aren't declared, since Reserva can't know which adapters you use. Add the ones you
use to your own `env.schema` if you want them typed. Pass `envSchema: false` to `reserva()` if
you declare these names yourself.

Reserva can only read its own `RESERVA_*` secrets, each `config.webhooks[].secretBinding`, and
whatever you list in `secretBindings`.

## Typed bindings

Generate `worker-configuration.d.ts` from `wrangler.jsonc` before each run:

```json
{ "scripts": { "pretypes": "wrangler types --include-runtime=false", "predev": "wrangler types --include-runtime=false" } }
```

`--include-runtime=false` keeps the workerd globals from overriding the DOM types your client
scripts need.

`wrangler types` declares a global `Env`, so pass it without importing:
`defineCloudflareReservaRuntime<Env>({ … })`. The `providers` and `logger` factories then get a
typed `env`, and a misspelled `db`, `cache` or `secretBindings` name fails to compile. Set
`cache: null` to turn caching off.

After `astro sync` (which `astro dev` and `astro build` run for you), `virtual:reserva/runtime`
and `virtual:reserva/config` are typed too.

## Admin access

The admin dashboard and the operator routes go through one `adminAuth` check:
`(request, context) => Promise<{ subject: string; email?: string } | null>`. `null`, a throw,
or no `adminAuth` at all all mean 403. While the admin or ops routes are on, the runtime
requires exactly one of `config.admin.access` or a custom `adminAuth`.

**Cloudflare Access** is wired in when you set `config.admin.access = { teamDomain, aud }`. Set
it up once in the Cloudflare dashboard:

1. Create a Zero Trust team. Its URL, `https://<team>.cloudflareaccess.com`, is your
   `teamDomain`.
2. Add a self-hosted Access application for your hostname's `booking/admin` path, and attach a
   policy.
3. Copy the application's Audience tag into `aud`.
4. Set the Access cookie's SameSite to `Lax` or `Strict`. Cloudflare's default is `None`, and
   a Worker can't change it.

Reserva verifies the `Cf-Access-Jwt-Assertion` header itself (signature, issuer, audience), so
a request that skips Access, through a `workers.dev` URL or a wrong route, still gets 403.

Access can't protect `localhost`, so output built by `astro dev` skips it: the admin resolves to
`{ subject: 'dev' }` and logs `admin auth bypassed: astro dev` once. The flag is set at build
time from Astro's own command, so `astro build` and `astro preview` output always calls Access.
A custom `adminAuth` is never bypassed.

**Admin forms are also CSRF-protected.** Every admin POST must come from the same origin:
`Sec-Fetch-Site` must be `same-origin` (`same-site` is refused, because an Access cookie often
covers the whole domain), or else `Origin` must match. With `RESERVA_CSRF_SECRET` set, each form
also carries a signed, expiring token tied to the signed-in user. Without it, only the origin
check runs.

## Manage links

Each booking gets two random tokens: a customer token, in the confirmation email's link, and an
operator token, shown only in the admin. Both open `/booking/manage?token=…`, which shows the
matching controls. The customer can cancel and reschedule within the cutoffs and never chooses a
refund. The operator can cancel with a refund choice, reschedule any confirmed booking, and mark
no-shows.

Only a SHA-256 hash of each token is stored. Both expire 60 days after the booking ends
(`booking.tokenExpiryDays` changes that). The customer token is revoked on cancellation; the
operator token isn't, so a stuck refund can still be finished. Expired, revoked and unknown
tokens all get the same 403.

A hash can't be turned back into a link. Set `RESERVA_TOKEN_ENC_KEY` so Reserva also stores
each token encrypted (AES-GCM) and emails and the admin can rebuild links. Without it, those
links are left out. The key only covers bookings made after it's set.

## Setup checklist

1. **Apply the migrations**: `bunx reserva-migrate --local` for the local database,
   `bunx reserva-migrate` for the remote one. It finds the D1 entry in your Wrangler config (the
   `RESERVA_DB` binding, your only `d1_databases` entry, or the one you name) and runs
   `wrangler d1 migrations apply` against Reserva's packaged `migrations/`. It accepts Wrangler's
   migration flags (`--env`, `--config`, `--remote`, `--preview`, `--persist-to`, …); anything
   after `--` passes through. If your binding sets `migrations_table`, pass the same name as
   `migrationsTable` to `defineCloudflareReservaRuntime`. The runtime checks the schema on each
   isolate's first request and names any missing migration.
2. **Bind `RESERVA_DB`**, and optionally `RESERVA_CACHE`.
3. **Add provider secrets** with `wrangler secret put`.
4. **Set up the Stripe webhook** at `/api/booking/webhooks/payment` with `@reservajs/stripe`'s
   [seven events](../packages/stripe/README.md#webhooks). Pin the endpoint's API version rather
   than following the account default, since the payload shape follows it. Don't enable delayed
   payment methods (Multibanco, SEPA Direct Debit, bank transfer). If one slips through, Reserva
   refuses it and refunds the money if it settles.
5. **Run `wrangler types`** and pass the global `Env` to `defineCloudflareReservaRuntime<Env>()`.
6. **Configure admin access**: Cloudflare Access or a custom `adminAuth`, as above.
7. **Set `RESERVA_TOKEN_ENC_KEY` before the first booking.** It can't be rotated later: links
   made under the old key stop working. Without it, the admin shows a warning.
8. **Set `RESERVA_CSRF_SECRET`.** Without it, the admin shows a warning.
   `GET /api/booking/ops/health` reports both under `security`.
9. **Partner offers** (optional): to let partner discounts apply, add `partnerOffers` to the
   runtime with a minimum charge per currency. See
   [Partner offers](./api.md#turning-offers-on).
10. **Deploy** with `@astrojs/cloudflare`. Don't prerender the booking routes.
11. **Add the scheduled sweep** (next section).
12. **Test on staging**: availability, checkout holds, webhook redelivery, confirmation,
    cutoffs, operator actions, admin sign-in.
13. **Monitor** the outbox and payment-webhook responses. Calendar and confirmation-email
    failures return non-2xx on purpose so the payment provider retries. Alert on repeated
    `503 confirmation_in_progress` (a stuck lease), on any `409 payment_amount_mismatch`, and on
    the "confirming expired hold after payment" warning, which may mean a slot was oversold by
    one.

## The scheduled sweep

The reconciliation sweep retries stuck deliveries and refunds, clears expired holds, sends
reminders, and opens or resolves the incidents behind the "Attention required" cards in the
admin. Run it from your site's own Worker. `@astrojs/cloudflare` honours a custom `main`, so the
cron shares the site's bindings and secrets:

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

```jsonc
// wrangler.jsonc
{
  "main": "./src/worker.ts",
  "triggers": { "crons": ["*/5 * * * *"] }
}
```

Leave out `satisfies ExportedHandler<Env>`: that type's `Request` clashes with the DOM `Request`
in a project with client scripts.

Every five minutes is the expected cadence (`RECONCILIATION_CADENCE_MINUTES`). Ops health opens a
`reconciliation_stale` incident when the last run is more than three ticks old.

`scheduledHandler` rethrows on failure, so a bad run shows as a failed cron invocation. Two runs
never overlap: the cron and `POST /api/booking/ops/reconcile` share a lease, and the one that
loses logs a warning and exits. Pass `ReconciliationOptions` as the second argument to change
`sourceLimit`, `alertLimit` or `queryBudget`.

To do more in the same invocation, call `runReconciliationWithLease(context, options)` with a
context built the way `scheduledHandler` builds it:

```ts
import virtualConfig from 'virtual:reserva/config';
import { withStoredSettings } from '@reservajs/astro/runtime';

const context = {
  ...(await withStoredSettings(await runtime.createContext({ request }))),
  routeConfig: virtualConfig.routes,
};
```

Without `withStoredSettings`, the sweep ignores values edited in the admin (such as the reminder
timing and the cancellation cutoff its emails mention). Without `routeConfig`, links in its
emails lose your `routePrefix`.

`POST /api/booking/ops/reconcile` runs the sweep on demand with the operator secret or an admin
identity. It takes an optional JSON body with `sourceLimit` and `alertLimit`, returns the
summary, and answers `409 reconciliation_in_progress` while another run holds the lease.

### Alerts

Alerts tell you an incident opened without you watching the admin. When `providers.alerts`
isn't set and the email provider has `sendMessage` (Brevo does), Reserva sends alerts by email
through `emailAlertSink` and logs `reserva operational alerts wired to the email provider` once.
Each alert goes to `business.contact.email` as saved in the admin. Without such a provider,
alerts only go to the Worker logs, with a warning. Set `providers.alerts` to send them somewhere
else.

Turn on Workers observability with full logs, and add a Cloudflare alert on cron failures. If
the cron itself fails, nothing inside it can send an alert.

## Rebuilding a static site on admin changes

Prices, hours, capacity and policy can be edited in the admin. A static site that bakes them in
at build time has to rebuild when they change. Subscribe a webhook to `settings.changed`, which
fires once per admin save, and have the build read `/api/booking/catalog`:

```ts
webhooks: [{
  name: 'rebuild',
  url: '<your deploy hook URL>',
  secretBinding: 'REBUILD_WEBHOOK_SECRET',
  events: ['settings.changed'],
}]
```

The request is a signed POST with no `Authorization` header and a fixed body, so it can't call
GitHub or a CI API directly. Two options work:

- **A Workers Builds deploy hook.** Accepts the POST as is, up to 10 builds per minute per
  Worker. Anyone with the URL can trigger a build.
- **A relay Worker.** Verify the signature with a Standard Webhooks library, then call GitHub
  `repository_dispatch` (or your CI's API) with a token kept server-side. Use this when the
  build runs on GitHub Actions.

A hook that arrives while a build is still queued is merged into it, which is fine because that
build hasn't read the catalog yet. A save during a running build queues a new one. Either way,
the last build always reads the latest values.

Delivery is best-effort: three attempts, then a logged error and no incident. Save again or
deploy by hand if a rebuild was missed. Partner edits don't trigger it.

## Reserva and your own migrations

Wrangler keeps one migration ledger per database (`d1_migrations`), shared by every set of
migrations applied to it. Give Reserva its own D1 database. `reserva-migrate` refuses to run if
the binding's `migrations_dir` already points somewhere else.

If you share a database anyway, don't reuse Reserva's migration filenames (`0001_init.sql` and
onwards): Wrangler would count yours as applied and skip Reserva's. The runtime also compares a
schema fingerprint and throws when the ledger and the actual tables disagree. That detects a
collision; it doesn't fix it.
