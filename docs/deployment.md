# Deploying on Cloudflare

Everything between a working local config and a production Worker: secrets, typed bindings,
admin access, the runbook, the scheduled reconciliation Worker, and how Reserva's migrations
sit next to your own.

## Secrets and `astro:env`

`reserva()` declares its providers' secret names in Astro's
[`env.schema`](https://docs.astro.build/en/guides/environment-variables/#type-safe-environment-variables)
as `envField.string({ context: 'server', access: 'secret', optional: true })`:

| Declared name | Provider | Set with |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | `@reservajs/stripe` | `wrangler secret put STRIPE_SECRET_KEY` |
| `STRIPE_WEBHOOK_SECRET` | `@reservajs/stripe` | `wrangler secret put STRIPE_WEBHOOK_SECRET` |
| `BREVO_API_KEY` | `providers/email-brevo` | `wrangler secret put BREVO_API_KEY` |
| `RESERVA_OPERATOR_SECRET` | operator endpoints (bearer auth) | `wrangler secret put RESERVA_OPERATOR_SECRET` |
| `GOOGLE_SA_EMAIL` | `providers/calendar-google` | `wrangler secret put GOOGLE_SA_EMAIL` |
| `GOOGLE_SA_PRIVATE_KEY` | `providers/calendar-google` | `wrangler secret put GOOGLE_SA_PRIVATE_KEY` |
| `GOOGLE_IMPERSONATE_EMAIL` | `providers/calendar-google` | `wrangler secret put GOOGLE_IMPERSONATE_EMAIL` |

Every entry is optional because providers are opt-in: a payments-only setup must not fail env
validation over a missing Brevo key. The declaration gives typed access through
`astro:env/server`; providers still receive credentials as constructor options from your
runtime module, and `secrets()` still exposes a closed allowlist: Reserva's own `RESERVA_*`
names, every `config.webhooks[].secretBinding`, and whatever `secretBindings` adds. Pass
`envSchema: false` to skip the contribution if your project declares its own schema for these
names.

## Typed environment bindings

Run `wrangler types` to generate `worker-configuration.d.ts` from your `wrangler.jsonc`,
wired as a `pretypes`/`predev` script so it stays current:

```json
{ "scripts": { "pretypes": "wrangler types", "predev": "wrangler types" } }
```

Pass the generated `Env` as the type argument, as in the quickstart. The `providers` and
`logger` factories then receive a typed `env`, and the `db`, `cache`, and `secretBindings`
options are constrained to `keyof Env`, so a misspelled binding is a compile error. The type
argument is optional. Set `cache: null` to disable caching entirely.

`reserva()` also calls `injectTypes()`, so after `astro sync` (run implicitly by `astro dev`
and `astro build`) the `virtual:reserva/runtime` module is typed as `ReservaRuntime`.

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

Access cannot protect `localhost`. For local development, omit `config.admin.access` and pass
a custom `adminAuth` (the smoke site does this). A real deployment must gate any such bypass
behind a `.dev.vars`-only variable; an unconditional bypass in shipped code is a fail-open
hole.

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
   canonical names.
4. Run `wrangler types` and pass the generated `Env` to `defineCloudflareReservaRuntime<Env>()`.
5. Implement or import the provider adapters in the runtime module.
6. Configure an admin auth strategy: Cloudflare Access matching `config.admin.access`, or a
   custom `adminAuth`. The runtime throws at startup if neither (or both) is configured while
   the admin/ops routes are enabled. Before go-live, confirm production defines no dev-bypass
   variable your `adminAuth` honors.
7. Deploy with `output: 'server'` and `@astrojs/cloudflare`. Do not prerender booking routes.
8. **Deploy the scheduled reconciliation Worker.** Reconciliation is a bounded sweep that
   resumes stuck side-effect and refund debt, clears expired holds, and opens or resolves
   operator incidents — the outage-survival backstop behind the "Attention required" cards on
   `/booking/admin`. `@astrojs/cloudflare` regenerates its Wrangler config on every build, so a
   `scheduled()` handler cannot be spliced into the site Worker: deploy a second Worker sharing
   your `RESERVA_DB` binding. The whole entrypoint is:

   ```ts
   // worker/scheduled.ts
   import { scheduledHandler } from '@reservajs/astro/runtime';
   import runtime from '../src/reserva-runtime';

   export default { scheduled: scheduledHandler(runtime) };
   ```

   `scheduledHandler` requires an operational alert sink and rethrows on failure, so a bad run
   is recorded as a failed cron invocation. Pass `ReconciliationOptions` as its second argument
   to change the limits, or call `runReconciliation(context, options)` yourself if you need to
   do more in the same invocation. The published package includes the complete template,
   `wrangler.jsonc` included, at
   [`../examples/smoke-site/worker/`](../examples/smoke-site/worker).

   The cron Worker does not inherit bindings or secrets from the site Worker. Configure on it
   every binding and secret your provider factory reads (`RESERVA_DB`, payment keys, Google
   calendar credentials, `BREVO_API_KEY`, every `secretBinding` from `config.webhooks`, the
   alert sink, `RESERVA_TOKEN_ENC_KEY`), repeating
   `wrangler secret put <NAME> --config worker/wrangler.jsonc` even for names the site Worker
   already has. Enable Workers observability with full logs on both Workers, and set up a
   Cloudflare-side alert on this Worker's cron failures before go-live: the in-process alert
   sink only fires from inside an invocation, so the platform alert is the independent
   detection path when the trigger itself fails.
9. In a staging Worker, verify availability, checkout holds, webhook redelivery, status
   confirmation, cutoffs, operator actions, and admin authentication.
10. Monitor the outbox and payment-webhook responses. Calendar and confirmation-email failures
    intentionally return non-2xx so the payment provider retries delivery. Also alert on
    persistent `confirmation_in_progress` 503s (a stuck lease), on `payment_amount_mismatch`
    409s (never expected in normal operation), and on the "confirming expired hold after
    payment" warning, which marks a possible one-slot oversell.

## Reserva and your own migrations

Reserva shares Wrangler's migration ledger (`d1_migrations` by default) with any migrations of
your own applied to the same database; Wrangler has no per-package namespaces. The supported
layout is a dedicated D1 database for Reserva. If you do share one, do not name a migration of
your own `0001_init.sql`, which is the whole of Reserva's schema: a colliding filename satisfies
the ledger check without creating that schema. The runtime
layers a schema fingerprint on top of the filename check and throws a distinct error naming
the likely collision when the ledger and the schema disagree. This is collision detection, not
a fix.
