# Reserva growth analysis — 2026-10-01

What stands between `@reservajs/astro` 0.15.0 and a much wider audience, and what to do about it before 1.0.
Code references are against `main` at `b015dda`.

**Status.** Struck-through items are done: conclusion 1 and the alert-recipient bug in PR #31,
the six "build now" items in the same PR. The [Decisions](#decisions-triage-with-the-maintainer-2026-10-01)
section at the end is the live list; everything above it is the analysis as written.

**Evidence labels**
- **[V]** verified by me: I read the code, executed it, or fetched the source.
- **[A]** reported by a research subagent with a URL; I did not re-fetch it.
- **[I]** inference: my reasoning, not a checked fact.

**Assumptions** (judgment calls made without asking)
1. "Wider audience" means more *adopters*: the developers and agencies who wire Reserva into a site for an operator. It does not mean operators buying a hosted product. Nothing in the repo points to a hosted offering.
2. The Workers **Free plan** is in scope. The `cpu-budget` changeset (commit `9693ccc`, 2026-09-29) explicitly targets "10 ms on the Free plan". No doc names a required plan.
3. `docs/architecture.md` "Deliberate boundaries" and "Deferred" are treated as decided. So are the "Product rules fixed during planning" in `docs/tmp/implementation-plan.md:9-12`: Access-only admin auth, one shared capacity pool, no operator-created bookings. I challenge three of them below, each with its evidence and cost.
4. Nothing already in `docs/tmp/lib-review-2026-09-16.md` or `implementation-plan.md` is repeated as a finding unless its premise has since changed.

---

## The bet

**Bet on distribution, not portability.** Concretely, Reserva should be usable from any website with as little code as possible, while still running in the adopter's Cloudflare account. After that, widen the business shapes the slot model can hold (tours first). Do not chase other hosts or databases yet.

Why this bet:

- **The website is the bigger filter, not the host.**
  - Today an adopter must build their site in Astro, deploy it as the same Worker, and write the funnel themselves.
  - The two real consumers each wrote 1.2k–1.7k lines of funnel UI [V]:
    - `examples/smoke-site/src/components/BookingWidget.astro`: 820 lines, plus 321 of CSS and 86 of messages.
    - mazetours: `BookingFunnel.astro` 1,333 + `BookingStart` 200 + `MeetingPointMap` 160 + page 50.
  - An embeddable widget is the one feature every comparable product ships, across all four verticals and the OSS field [A].
  - A Reserva Worker that any site can call, cross-origin, removes both the framework filter and the hosting filter for the *website*. That reaches WordPress, Squarespace, Webflow, Next.js and every non-Astro site, and needs no second database backend.
- **Tours are where the model fits and the money argument is strongest.**
  - Tour platforms take 1–3% from the operator (Rezdy 3%, Bókun 1–1.5%, Checkfront €99 + 3%) or 2.4–8% from the customer (FareHarbor, Peek, Xola) [A, URLs in Q4].
  - Bookeo is the only flat-fee, no-commission analog.
  - Restaurants already have "no cover fees" vendors (Resy, SevenRooms, resOS) [A]. Studios need packs and memberships, which the slot model doesn't have.
- **Cloudflare is a reasonable home for the long run.**
  - Cloudflare acquired Astro on 2026-01-16, and Astro stays MIT and multi-platform [V] (https://blog.cloudflare.com/astro-joins-cloudflare/).
  - Cloudflare's share of JS hosting rose from 20.8% (State of JS 2024) to 28.4% (2025) [A] (https://2025.stateofjs.com/en-US/other-tools/).
  - The atomic capacity guard is a real differentiator: check-then-insert races are documented in Easy!Appointments, LibreBooking and several WordPress booking plugins [A]. A port must not trade that away.

---

## Conclusions to act on, ranked by audience unlocked ÷ cost

| # | Change | Unlocks | Cost | Where |
|---|---|---|---|---|
| 1 | ~~Make the capacity default honest (per-person vs per-booking) and fix the two example configs that oversell 8× and 4×~~ (done, PR #31) | Correct results for every restaurant- and class-shaped adopter, who start from those examples | Tiny | Core config + examples |
| 2 | ~~Cross-origin API (CORS allowlist + `OPTIONS`)~~ (done) and a standalone "Reserva Worker" template with a Deploy to Cloudflare button; then an optional drop-in widget | Any website on any stack; agencies; less technical adopters | Small (CORS), small–medium (template), medium (widget) | Core (CORS); separate template repo; separate package for the widget |
| 3 | ~~Fit the Free plan's 50-queries-per-invocation limit in the sweep, or state that Workers Paid is required~~ (done: query budget) | Every Free-plan deployment, at exactly the moment it is recovering from an outage | Small | Core (reconciliation) + docs |
| 4 | Bookings that don't go through Stripe Checkout: staff/phone bookings in the admin, pay on arrival, deposits; customer contact fields on `CheckoutRequest` | Restaurants, classes, any operator taking phone bookings; later resellers (OCTO/GetYourGuide) | Medium | Core |
| 5 | Capacity pools per service (more than one fleet/resource) | Tour operators with more than one boat, vehicle or guide team; any business selling two products that don't share capacity | Medium | Core (migration + guard predicate) |
| 6 | Expose the engine as a framework-agnostic `fetch`/`scheduled` handler, with Astro as a thin adapter | Workers users on Hono, React Router, TanStack Start or vinext; also a prerequisite for any port and a fix for a settings leak | Small–medium | Core refactor |
| 7 | Stay Cloudflare-only for the backend. If a port is ever triggered, target the SQLite family via a D1-shaped executor seam, never Postgres | — (a decision, not a build) | None now | — |

Supporting items that fit inside these conclusions:
- Turnstile on checkout (small, core, optional) — see Q2.
- An MCP route as an example (cheap) — see Q2/Q4.
- Promo codes (medium, core pricing path) — see Q4.

### 1. ~~Make the capacity default honest (tiny)~~ — done in PR #31

**What's wrong**
- A service with no `occupancy` takes **one capacity unit per booking, whatever the party size** (`src/core/occupancy.ts:137-142`) [V].
- `docs/configuration.md:56-59` calls this "what most deployments want".
- Two of the three vertical examples get it wrong. I executed `validateConfig` + `occupancyFor` on them [V]:

| Example | Config | Commented intent | Real ceiling per slot |
|---|---|---|---|
| `examples/configs/restaurant.ts:16` | `capacity: { default: 40 }`, parties up to 8 (`:26-28`), no `occupancy` | 40 covers | **320 covers** |
| `examples/configs/fitness-studio.ts:15` | `capacity: { default: 12 }`, up to 4 per booking (`:28-31`), no `occupancy` | 12 places, per-class capacity (comment at `:2`) | **48 people** |

- `tour-operator.ts` declares `occupancy: { seatsPerUnit: 3 }` and is correct.

**Who it blocks.** The restaurant and class adopters the README advertises (`README.md:21`). They copy an example and oversell, and nothing tells them.

**Fix**
- Make `occupancy` required whenever any pricing row has `maxQuantity > 1`. Or flip the default to one unit per person and make "one unit per booking" the explicit opt-in.
- Fix both examples.
- This is a breaking change, which is cheap before 1.0.

### 2. Let the website live anywhere (small → medium, staying on Cloudflare)

**Evidence**
- `@reservajs/astro/client` advertises a cross-origin funnel: `base: 'https://booking.example.com'` (`src/client/index.ts:56-58`) [V].
- There is **no CORS handling anywhere in `src/`**. A grep for `Access-Control` finds nothing, and no route exports `OPTIONS` [V]. The only hit for "CORS" is a comment at `src/client/index.ts:204`.
- The client sends `content-type: application/json`, and the manage flow sends `x-reserva-manage-token`. Both trigger a preflight, so a funnel on another origin cannot call the API at all [I, standard CORS behaviour].
- The setup cost is also high. An adopter needs four files plus the 12-step runbook in `docs/deployment.md:120-245` (Access, secrets, `RESERVA_TOKEN_ENC_KEY`, CSRF secret, custom Worker entry, cron, observability) [V].

**What to build, in order**
1. ~~**CORS allowlist** (core, small).~~ Done as `routes.cors.origins`.
   - Config: `routes.cors: { origins: string[] }`. Answer `OPTIONS` for the customer group only; never for admin or ops.
   - The webhook route needs none.
   - The manage token header has to be in `Access-Control-Allow-Headers`.
2. **Standalone template** (separate repo, small–medium).
   - A minimal Astro-on-Workers project containing only Reserva, its config and the confirmation/manage pages, with a Deploy to Cloudflare button.
   - The button provisions the D1 binding and prompts for the secrets listed in `.dev.vars.example`. Migrations run from the `deploy` script, e.g. `"deploy": "reserva-migrate && wrangler deploy"` [A] (https://developers.cloudflare.com/workers/platform/deploy-buttons/, https://developers.cloudflare.com/changelog/post/2025-07-01-workers-deploy-button-supports-environment-variables-and-secrets/).
   - Access and the Stripe webhook endpoint stay manual steps. The template's README should be the runbook.
   - Stripe already redirects to the Reserva origin's `/booking-confirmation`, and those pages are branded through `ui.branding`. So the customer's path works unchanged once the funnel is elsewhere [V: `docs/configuration.md`, routes table].
3. **Optional drop-in widget** (separate package or `./widget` subpath, medium).
   - A framework-agnostic custom element built only on `./client`, promoted from the tested smoke-site widget (`tests/ui-booking-widget.test.ts` already covers it).
   - Today that widget is an Astro component with a server-rendered shell [V], so the port is real work.

**Boundary challenged: "No customer booking-funnel UI ships in the package".**
- Keep the *package* headless. Ship the widget as a separate, optional artifact.
- Evidence for the challenge: two consumers each re-wrote about 1.5k lines of funnel UI [V], and every comparable product ships a widget [A].
- Cost: one more artifact to version and test against the wire contract. The contract is already generated and typed, which keeps that cost bounded.

### 3. ~~Fit the plan you target (small)~~ — done: per-sweep query budget

**Real-D1 numbers** (measured after the fact against workerd's D1, counting every statement inside a
`batch()` the way the cap does): an empty sweep issues 9 queries; each owed confirmation row costs
9 to execute plus 2 to project; a reminder costs 1 + 3 per outbox row; an alert 3; a refund
resumption 2 to load, then 3, or 7 + 2 per cancellation outbox row. Without the budget, the outage
backlog in `tests/workers/reconciliation-query-budget.test.ts` took 198 queries in one sweep. The
fake-based table below undercounts batches and is kept as written.

**Measured** (before the fix) with `docs/tmp/growth-analysis-sweep-queries.ts`. Run it with `bun --preload ./docs/tmp/perf/bun-virtual-config.ts docs/tmp/growth-analysis-sweep-queries.ts` [V].
- The script counts `BookingRepository` calls during one `runReconciliationWithLease`.
- Every repo method issues at least one D1 query, so the count is a lower bound.

| Confirmed bookings each owing `calendar_create` + `email_confirmation` | Repo calls (warm isolate) |
|---|---|
| 0 | 11 |
| 1 | 30 |
| 3 | 68 |
| 5 | 112 |
| 10 | 213 |
| 20 | 415 |
| Payment-webhook confirmation of one hold (calendar + customer/owner email) | 24 |

- The per-booking cost is about 20 calls. Lease renewals alone account for 6 per booking (`renewConfirmationLease` 30 for 5 bookings), and each effect does claim/resolve/getIncidentBySource.
- A **cold** isolate adds 13 more: the schema check is 2 queries + index list + 9 `table_info` for the 9 tables in `RESERVA_SCHEMA_TABLES`, plus `listSettings`.

**Limit.** D1 allows **50 queries per Worker invocation on Free** and 1,000 on Paid [V] (https://developers.cloudflare.com/d1/platform/limits/).

**Consequence**
- After a short calendar or email outage, the 5-minute sweep exceeds the Free cap with **two** owed bookings on a warm isolate, or **one** on a cold one (43).
- That is exactly the situation the sweep exists for.
- [I] Each run probably makes partial progress before D1 throws, so the backlog drains slowly and noisily rather than never. I did not run this against real D1 on Free.
- The webhook confirmation path (24 + handler lookups + 13 cold) sits close to 50. Each added webhook subscriber or durable hook adds a claim/resolve pair [I].

**Fix**
- Give the sweep a query budget per invocation: stop cleanly near the cap and let the next tick continue.
- Batch the per-effect claim/resolve/renew statements (D1 `batch()` is one call).
- If neither is wanted, document "Workers Paid required" in the README.
- Cloudflare Email Sending, a likely future adapter, is Paid-only anyway [A] (https://developers.cloudflare.com/email-service/platform/pricing/).

### 4. Bookings not paid through Reserva's Stripe Checkout (medium)

**Evidence**
- Every hold goes through `payments.createCheckout` (`src/handlers/checkout.ts:241-342`) [V].
- Confirmation requires `paid === true`, an exact `amountTotal === booking.priceMinor`, and a currency match (`src/core/payment-verification.ts:28-45`) [V]. A zero price needs `no_payment_required` from the provider.
- So pay-on-arrival, a deposit with a balance later, or a phone booking each require a `PaymentProvider` that lies about payment.
- The admin cannot create a booking. "No operator-created bookings" was a planning rule (`implementation-plan.md:12`) [V].
- `CheckoutRequest` has no name/email/phone fields (`src/core/api.ts:130-141`). Contact details come only from the payment page [V].

**Who it blocks**
- Staff/phone bookings are table stakes for tours (Checkfront, Bókun, Rezdy, TrekkSoft, Regiondo, Ventrata) [A].
- Deposits and pay-later are table stakes for tours and restaurants [A].
- The restaurant example's own comment says "the balance is settled in person" (`examples/configs/restaurant.ts:1-2`), yet the price row has to be the deposit [V].
- Any future reseller channel needs it too: OCTO confirms by API at net rates, with no checkout page [A] (https://docs.octo.travel/octo-api-core/bookings).

**Shape** [I]
- A booking *payment mode*, decided per service or per request: `checkout` (today), `deposit { amountMinor }`, `none`.
- An admin "new booking" form that goes through the **same** `insertHoldWithCapacity` guard and a confirm path that records `paymentMode` and the expected amount.
- `verifyPayment` then compares against the expected captured amount instead of the full price.
- Optional contact fields on `CheckoutRequest` for the `none` mode, where there is no payment page.

**Boundary challenged: "No operator-created bookings".**
- Evidence: it is table stakes in the tours vertical and the restaurant example already needs it.
- Cost: medium, in core.
- It reuses the guard, outbox and events unchanged, and adds one column and one admin form.
- It does **not** add a second payment adapter, so "Stripe is the only shipped adapter" survives.

### 5. Capacity pools per service (medium)

**Evidence**
- All services draw from one pool: one `capacity.default` plus day overrides and dated defaults (`README.md:21`: "independent fleets are not modelled"; `implementation-plan.md:550-554` item 18, "decided: no change") [V].
- A tour business that sells a boat trip and a walking tour must share one number between them, or run two Reserva deployments.
- Multiple resources with auto-assignment is the clearest structural gap against tour platforms. FareHarbor: "Share inventory between all your offerings… resource tracking and auto-assignment" [V] (https://fareharbor.com/manage/inventory-management/). Bókun Allocation Manager, Rezdy, Checkfront, Bookeo, TicketingHub and Xola all have it [A].

**Cost** [V: code read; I: estimate]
- A `pool` key on `capacity_defaults`, `day_overrides` and `bookings` (migration with default `'default'`).
- `services.<slug>.pool` in config.
- `AND pool = ?` in the guard's sum and in the capacity lookup in `insertHoldWithCapacity` (`src/repo.ts:1328-1414`) and `rescheduleWithCapacity` (`:1788-1858`).
- The `occupancy.ts` mirror, plus per-pool rows in the admin capacity editor.
- The guard's *structure* (single statement, single writer) does not change, so the load-bearing property in Q3 is untouched.
- Auto-assignment across resources (boat A full → boat B) is a separate, larger step. Leave it out.

**Boundary challenged: plan item 18.** Its trigger was implicitly "nobody needs it". The vertical research says tours do. Ship pools only, not resource assignment.

### 6. Framework-agnostic handler; Astro as adapter (small–medium)

**Evidence of coupling** [V]

The engine is mostly *packaged* through Astro: handlers take a `Request` and a context. Real coupling sits in a few places:

| Coupling | Where |
|---|---|
| `astro/zod` | `src/core/config.ts:1`, `src/core/settings.ts:1`, `src/routes-manifest.ts:5` |
| `virtual:reserva/config` read inside the engine, not only in routes | `src/runtime-context.ts:4`, `src/reconciliation.ts:6` (used only at `:522`), `src/alerts/email-sink.ts:5` |
| Route controller logic in an Astro route instead of a handler | `src/routes/booking/manage.ts` (212 lines) |
| Cloudflare types leak into every consumer's `dist/*.d.ts` | `tsconfig.build.json:16` `"types": ["@cloudflare/workers-types"]` |

**A correctness payoff, not just reach.** Every entry point must remember to overlay stored settings and `routeConfig`.
- `src/routes/route-context.ts:10-17` does it for routes.
- `docs/deployment.md:204-217` tells consumers to do it by hand in their scheduled handler.
- One path already forgets:
  - `business.contact.email` is admin-editable (`src/core/settings.ts:187-190`).
  - Alerts are addressed from the *file* config (`src/runtime-context.ts:204,268`; `src/alerts/email-sink.ts:30` validates `virtualConfig.config` without stored settings).
  - ~~So an operator who changes the contact email in the admin keeps receiving no alerts at the new address [V, by reading; not executed].~~ Fixed in PR #31.
- A single `createReservaHandler({ config, runtime }) → { fetch, scheduled }` composes this once.

**Shape**
- Depend on `zod` directly.
- Pass the resolved config into the engine. The Astro integration supplies it from the virtual module.
- Move `manage.ts` logic into `src/handlers`.
- Add a small router over `routeManifest`.
- `scheduledHandler` already ignores its arguments (`src/reconciliation.ts:515-536`).
- Astro keeps `injectRoute`, the dev bypass, assets and `<ManageBooking />`.

**Who it unlocks** [A]
- Cloudflare documents custom Worker entries for React Router, TanStack Start, Hono, RedwoodSDK and OpenNext, and recommends vinext for Next.js (https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/, https://github.com/cloudflare/vinext). SvelteKit has no official path (https://github.com/sveltejs/kit/issues/13692).
- This also makes conclusion 2's standalone Worker possible without Astro at all.

### 7. Stay Cloudflare-only for the backend (decision)

The full argument is in Q3. In short:
- A port is feasible for the SQLite family at modest code cost, through an executor seam below `BookingRepository`.
- The real costs sit elsewhere:
  - admin auth without Access, which contradicts plan item 11;
  - IP trust without `cf-connecting-ip`;
  - a scheduler on every host;
  - about 150 real-D1 tests to run twice;
  - a split positioning.
- Conclusion 2 reaches more sites for less.

**Revisit trigger:** adopters name *hosting* (not the website stack) as the blocker. Do conclusion 6 first either way; it puts the seam in the right place.

---

## Q1 — Where the library falls short today

### Depth (codebase-design vocabulary)

**Deep — leave them alone** [V]
- **`PaymentProvider`** (`src/core/events.ts:161-196`). Four required members hide holds, verification, confirmation, the outbox, refunds and disputes. Stripe is one adapter; the port is honest.
- **Confirmation, outbox and reconciliation machinery** (`src/confirmation.ts`, `src/reconciliation.ts`). Callers see `confirmBookingFromPayment` and `scheduledHandler`.
- **Config validation.** One Zod pass with key-path errors.
- **The browser client** (`src/client/index.ts`). It chunks availability into 62-day windows and has a typed `ReservaApiError`.
- **`EmailProvider`** (`src/core/events.ts:115-140`). The deepest extension point: `send` alone works, and the optional members add routing.

**Shallow — matters for growth**
- **`BookingRepository`** has **81 methods** (`src/repo.ts:341-642`) [V].
  - Almost every method is one SQL statement. Callers must know the CAS, lease and claim protocols to use them correctly.
  - It reaches consumers raw through `ReservaContext.repo` and `.db` (`src/context.ts:44-72`), but the type is not exported from a package subpath. So overriding `repo` means re-implementing 81 methods against an unexported interface.
  - It is the wrong seam for a storage port. The right one is a D1-shaped executor *below* it: `src/schema-check.ts:16-18` `MigrationsQueryable` is the precedent.
  - ~~`docs/architecture.md:79` says "~59 methods", which is drift [V].~~ Corrected to 81.
  - The deferred split's trigger ("concurrency patterns stable") is fine. It does not block any recommendation here, because a port would cut below this module, not through it.
- **Context composition is leaky.** See conclusion 6: every caller must apply `withStoredSettings` + `routeConfig`, and alerts already miss it.

### How far a consumer can customize before forking [V]

| Layer | What it allows | Ceiling |
|---|---|---|
| Config (≈103 leaves, ≈28 admin-editable) | hours, pricing (rows or formula), policy, metadata fields, locales | — |
| `ui.messages`, `ui.branding`, CSS hooks | restyle confirmation/manage pages and emails | markup is fixed |
| Providers (payment/calendar/email/alerts) | swap any external system | deep and good |
| Hooks/webhooks (`src/core/events.ts:306-311`) | react after commit | **post-commit only: no context, no veto, no enrichment** |
| Own funnel on `./client` | full control of the customer UI | — |
| `AdminAuth` (`src/context.ts:42`) | `(request, context) → identity \| null` | **cannot redirect**, so no login flow without Access |

Fork points I can name:
- Any price change after the quote (promo code, voucher, deposit), because `verifyPayment` demands the stored price.
- Any pre-hold business rule (minimum party for a private departure, blackout per customer), because there is no pre-hold hook.
- Any admin auth that needs a login page.

### Ergonomics

- **Config: good.** Plain data, validated once, errors name the key [V].
- **Runtime setup: heavy.**
  - Four files plus a 12-step runbook (`docs/deployment.md:120-245`) [V], and no statement of the required plan.
  - The template in conclusion 2 is the fix. More defaults would not be.
- **Public surface: wide with holes.**
  - About 223 exported symbols across 11 subpaths [V].
  - ~~`CancelRequest`, `RescheduleRequest` and `ApiErrorDetails` are defined in `src/core/api.ts:53,233,246` but **not** re-exported from `src/core/index.ts` [V]. AGENTS.md names `ApiErrorDetails` as part of the contract.~~ Exported.
- **Client: good**, ~~except that the cross-origin `base` it advertises cannot work (conclusion 2)~~ and its cross-origin `base` now works with `routes.cors`.

---

## Q2 — Fitting Cloudflare better

### Platform primitives: does each one solve a real problem?

| Primitive | Real problem it would solve | Verdict |
|---|---|---|
| **Turnstile** | Hold hoarding. Holds lock capacity for ≥35 min. The only defense is `maxHoldsPerIp` keyed on `cf-connecting-ip` (`src/handlers/checkout.ts:237-239`), and the Free WAF gives one IP-only rule with a 10 s window [A] (https://developers.cloudflare.com/waf/rate-limiting-rules/). Turnstile is free with unlimited Siteverify [A] (https://developers.cloudflare.com/turnstile/plans/) | **Do it.** Optional `checkout.turnstile` with a secret binding; verify before `insertHoldWithCapacity`. Consistent with the AGENTS.md boundary: this is bot proof per hold, not IP rate limiting. Small, core |
| **Email Sending** | No third-party email account needed; fits "runs in your account" | **Later, behind `EmailProvider`** as an adapter subpath. Public beta since 2026-04-16, Workers Paid only, needs Cloudflare DNS [A] (https://developers.cloudflare.com/email-service/platform/pricing/, https://developers.cloudflare.com/email-service/platform/limits/) |
| **Deploy to Cloudflare button** | Setup cost (conclusion 2) | **Do it** in a template repo |
| **MCP (`createMcpHandler`)** | Agent channels. Peek, TicketingHub, SimplyBook and Cal.com ship MCP servers [A] (https://www.peek.com/mcp, https://cal.com/docs/mcp-server) | **Example only.** Catalog/availability/quote/checkout-link tools over the public API; stateless [A] (https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/) |
| Durable Objects (SQLite) | Per-slot serialization | **Leave.** D1 already serializes writes, and the guard is atomic [V]. Moving capacity into a DO splits it from bookings and the outbox, which then can't commit in one batch |
| Queues | Faster outbox dispatch | **Leave.** Enqueue isn't atomic with the D1 write [A] (https://developers.cloudflare.com/queues/reference/delivery-guarantees/), so the outbox stays anyway. Inline dispatch via `waitUntil` already covers latency |
| Workflows | Hold expiry, reminders | **Leave.** Same atomicity problem. The cron sweep already does this. Cron→Workflow binding (2026-06-02) [A] doesn't change that |
| D1 read replication | Read latency | **Leave.** Reads are small, and Sessions-API consistency would complicate availability [A] (https://developers.cloudflare.com/d1/best-practices/read-replication/) |
| Rate Limiting binding | Per-IP limits | **Leave.** Approximate and per-location [A] (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/); Turnstile covers the real threat |
| Workers' built-in Access (`ctx.access`, 2026-08-14) | Drop the hand-rolled JWT check in `src/access.ts` | **Leave for now.** Per the agent, it doesn't reach Workers serving static assets, and the current Web Crypto check works [A] (https://developers.cloudflare.com/changelog/post/2026-08-14-workers-access/) |
| Secrets Store, Hyperdrive, Containers, Workers for Platforms | — | **Leave.** No problem to solve. WfP ($25/mo) only matters for a hosted multi-tenant product [A] |

**No Cloudflare primitive offers a transactional outbox** [A]. The D1 outbox (`side_effect_operations`) written in the same batch as the mutation (`src/repo.ts:1111-1149`, `:2017`) is the right design and should stay.

### Astro coupling

- Packaged through Astro, not built on it. See the conclusion 6 table.
- The rest is ordinary packaging, and it stays in the adapter:
  - `injectRoute` for 19 routes (`src/integration.ts:120-209`);
  - Vite virtual modules;
  - the adapter warning (`:194-200`);
  - the dev bypass;
  - `<ManageBooking />`.
- Route files are 9-line `APIContext` wrappers (e.g. `src/routes/api/booking/checkout.ts`) [V].
- Astro-first remains the right default. A framework-agnostic handler widens reach without a pivot.

---

## Q3 — Other platforms

### Dependency map

| Dependency | Where | Incidental / load-bearing | Replacement off Cloudflare |
|---|---|---|---|
| **Single-writer serialized writes; `batch()` = one transaction** | `src/repo.ts:1328-1414` (hold guard), `:1788-1858` (reschedule CAS), `:1111-1149` (outbox in the same batch), `:2017`; stated in `tests/workers/capacity-allocation.test.ts:15-17` | **Load-bearing** (the property, not the product) | Any SQLite-family store with write-locking transactions (table below). Postgres/MySQL need a redesign |
| SQLite dialect: `FROM (VALUES …)` + `column1..5`, `json_set`, `json_extract`, `julianday`, `datetime`, scalar `MAX` | `src/repo.ts:1111-1149`, `:1638`, `:1939`, `:2119` | Incidental within SQLite; load-bearing against Postgres | none needed in the SQLite family |
| `D1Database` API shape (`prepare/bind/first/all/run/batch`) | `src/context.ts:44-72`, `src/runtime-context.ts:1` | Incidental | D1-shaped executor seam; precedent `src/schema-check.ts:16-18` |
| D1 per-batch limits (366-day chunking) | `src/repo.ts:1961-1973` | Incidental | — |
| `cloudflare:workers` `env` | `src/runtime-context.ts:72-95` | Incidental | `process.env` |
| `waitUntil` for non-durable dispatch | `src/runtime-context.ts:72-95` | **Load-bearing on freeze-after-response runtimes** (serverless functions); incidental on a long-lived Node/Bun process | Vercel `waitUntil` from `@vercel/functions` [A]; await inline elsewhere |
| Secrets as bindings, allowlisted | `src/runtime-context.ts:213-291` | Incidental | env vars |
| `caches.default` | `src/runtime-context.ts:97-106` | Incidental (optional cache) | none / in-memory |
| Cron Trigger → `scheduledHandler` | `src/reconciliation.ts:515-536`; `examples/smoke-site/src/worker.ts`; cron `*/5 * * * *` | **A periodic trigger is load-bearing** (hold expiry, outbox retries, reminders, stale incidents). Cloudflare Cron itself is incidental | `Bun.cron` / node-cron in-process; platform cron calling `/api/booking/ops/reconcile`. Vercel Hobby cron runs once a day, so Pro is needed [A] (https://vercel.com/docs/cron-jobs/usage-and-pricing); Railway ≥5 min [A] |
| Cloudflare Access | `src/access.ts`; `src/core/config.ts:619-633` (`*.cloudflareaccess.com`); `src/runtime-context.ts:146-167` | Incidental in code (an `AdminAuth` port exists); **load-bearing in product** (plan item 11: Access is the only production auth) | Access in front of a VPS via Tunnel [I], or a built-in auth that `AdminAuth` can't express today (no redirect) |
| `cf-connecting-ip` | `src/handlers/checkout.ts:237-239` | **Load-bearing for `maxHoldsPerIp`.** The `x-forwarded-for` fallback is spoofable off Cloudflare | trusted-proxy configuration |
| `reserva-migrate` wraps `wrangler d1 migrations apply`; ledger `d1_migrations` | migrate CLI (364 lines); `src/schema-check.ts:4` | Incidental (plain SQLite DDL) | own runner writing the same ledger table |
| Schema check via `sqlite_master` / `PRAGMA table_info` | `src/schema-check.ts` | Incidental within SQLite | — |
| `@astrojs/cloudflare` adapter warning; dev bypass from Astro's command | `src/integration.ts:194-200` | Incidental | — |
| `@cloudflare/workers-types` in published types | `tsconfig.build.json:16` | Incidental (and a type leak today) | scoped type imports |

### Which stores give the guards' property

The guards need more than single-statement atomicity. They need **the write lock to be held before the guard's reads**, so two concurrent holds cannot both read "space left".
- SQLite does this: a write statement opens a write transaction before reading. Its EXPLAIN starts with `Transaction 0 1` [V].
- D1 serializes all statements per database [V] (`tests/workers/capacity-allocation.test.ts:15-17`; https://developers.cloudflare.com/d1/worker-api/d1-database/).

| Store | Provides it? | Same SQL? | Notes |
|---|---|---|---|
| D1 | yes | yes | today |
| Durable Object SQLite (`transactionSync`) | yes | yes | [A] https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ |
| bun:sqlite, better-sqlite3, node:sqlite | yes, single process with `BEGIN IMMEDIATE` around batches | yes | [A] https://www.sqlite.org/lang_transaction.html; `node:sqlite` is a release candidate [A] https://nodejs.org/api/sqlite.html |
| libSQL / Turso (default) | yes: `batch(…, 'write')` is `BEGIN IMMEDIATE` | yes | [A] https://docs.turso.tech/sdk/ts/reference |
| Turso MVCC `BEGIN CONCURRENT` | **no**: snapshot isolation, write skew | — | [A] https://turso.tech/blog/concurrent-writes-on-turso-cloud |
| Postgres READ COMMITTED / REPEATABLE READ | **no**: write skew, oversells | no | [A] https://www.postgresql.org/docs/current/transaction-iso.html |
| Postgres SERIALIZABLE | yes, with a `40001` retry loop | no | dialect rewrite as well |
| Postgres + `pg_advisory_xact_lock` or `FOR UPDATE` on a per-day row, taken before the guard | yes | no | Needs an interactive transaction or a function. CAS + outbox becomes `WITH u AS (UPDATE … RETURNING) INSERT … FROM u` [A] https://www.postgresql.org/docs/current/explicit-locking.html |
| MySQL/InnoDB | not as written: `UPDATE … WHERE EXISTS (SELECT … FROM bookings)` is rejected (error 1093); gap locks deadlock | no | rewrite + deadlock retry [I] |
| Deno KV, DynamoDB | no SQL | — | counter-key redesign |

**Portability layers don't help.** Drizzle's `batch` works only on D1, libSQL and neon-http [A] (https://orm.drizzle.team/docs/sqlite/batch-api). Kysely's D1 dialect and `db0` have no transactions [A] (https://github.com/unjs/db0/blob/main/src/connectors/cloudflare-d1.ts).

**OSS peers don't attempt it either.**
- Nearly every OSS scheduler supports one database [A].
- pretix supports two, but its locking only works on Postgres [A] (https://github.com/pretix/pretix/blob/master/src/pretix/base/services/locking.py).
- Cal.com declined MySQL and SQLite despite having an ORM [A] (https://github.com/calcom/cal.diy/issues/11).

### What a port would look like [I]

1. **Executor seam** below the repo: `{ prepare(sql).bind(...).first/all/run, batch(stmts) }`, D1-shaped. Adapters: D1 (identity), libSQL (`batch(…,'write')`), bun:sqlite/better-sqlite3 (sync, `BEGIN IMMEDIATE`). No SQL changes.
2. **Scheduler:** a `startReservaScheduler()` for long-lived processes, plus docs for platform cron hitting the reconcile route.
3. **Admin auth off Access:** a login flow. This needs `AdminAuth` to return a redirect, and reverses plan item 11's "no password auth".
4. **IP trust:** a `trustProxy` setting.
5. **Migrations:** a small runner writing `d1_migrations` (`src/schema-check.ts:4` already names the table).
6. **Tests:** the 23 files and about 151 tests in `tests/workers/` run against real D1. They would need to run against at least one more driver.

### Realistic targets and audience

npm weekly downloads for 2026-09-23 → 09-29 [V] (`https://api.npmjs.org/downloads/point/2026-09-23:2026-09-29/<pkg>`):

| Target | Signal | Fit |
|---|---|---|
| Node/Bun + SQLite in Docker/VPS/Fly/Railway | `@astrojs/node` 1,067,800/wk ≈ `@astrojs/cloudflare` 1,175,253/wk | Best port target: same SQL, long-lived process, any cron. In principle it roughly doubles the Astro-addressable base [I] |
| Vercel + Turso | `@astrojs/vercel` 495,408/wk; `@libsql/client` 3.72M/wk | Works with `batch(…,'write')`, but Hobby cron is daily, so Pro is required [A] |
| Netlify | `@astrojs/netlify` 64,055/wk; Netlify Database is Postgres (Neon) [A] (https://www.netlify.com/changelog/2026-04-28-netlify-database/) | Poor: Postgres |
| Deno Deploy | KV | Poor |

For scale: `astro` 7,239,625/wk, `@reservajs/astro` 2,142/wk [V].

### Should it? No, not now

**Cost**
- One more storage adapter, scheduler and migrations runner.
- An admin-auth feature the plan rejected.
- A doubled real-database test matrix.
- A second runbook.
- Blurrier positioning. "Runs in your Cloudflare account, no per-booking fees" is concrete, and the closest new entrant is also Cloudflare-native: `CCCrafts/punctual`, an edge-native Calendly alternative created 2026-08-13 [V] (https://github.com/CCCrafts/punctual).

**Gain**
- Astro-on-Node adopters who won't open a Cloudflare account.
- Conclusion 2 serves most of them anyway: their *site* can stay on Node while Reserva runs as a free Cloudflare Worker.

**Revisit trigger**
- Adopters say hosting, not the website stack, is the blocker.
- If it comes, do the Node/Bun + SQLite target after conclusion 6. Never Postgres unless the product becomes multi-tenant hosted.

---

## Q4 — What comparable products offer that Reserva doesn't

I confirmed in code that each "lacks" item is absent before listing it [V]:
- no admin booking creation (`src/handlers/admin.ts` actions are incident/settings/capacity only);
- no discount/voucher path (single pricing path + exact `verifyPayment`);
- one capacity pool;
- `quantity` is a scalar (`src/core/api.ts:130-141`);
- ~~no CORS;~~ (added since);
- no SMS or waitlist modules.

### Gap table

| Gap | Who it blocks | Class | Cost here | Where |
|---|---|---|---|---|
| Embeddable widget | Non-developer operators, agencies, any non-Astro site | **Table stakes**, every vertical [A] | Medium | Separate package (conclusion 2) |
| Staff/phone bookings, pay on arrival, deposits | Tours, restaurants, classes | **Table stakes** [A] | Medium | Core (conclusion 4) |
| Multiple resources / pools | Tour operators with more than one vehicle/boat; multi-product businesses | **Table stakes for tours** [V FareHarbor; A others] | Medium (pools); large (auto-assignment) | Core, pools only (conclusion 5) |
| Promo codes | Tours (Rezdy, Bookeo, TicketingHub, Xola [A]) | Table stakes | Medium: a code table with an atomic usage counter, applied when the hold is created so `priceMinor` is already discounted and `verifyPayment` stays exact [I] | Core pricing path, after conclusion 4 |
| Gift cards / vouchers with balance | Tours | Table stakes on paid tiers [A] | Large (balance ledger, partial redemption) | Nowhere for now |
| Ticket types (adult/child) | Tours; OCTO `unitItems` [A] | Table stakes [A: FareHarbor, Bookeo] | Large: `quantity` becomes a vector through pricing, occupancy, the guard's units and the wire | Later, core; after pools |
| Add-ons/upsells | Tours | Table stakes [A] | Medium (priced extras) | Later; not before promo codes |
| Waitlists | Fitness, restaurants | Table stakes there [A] | Medium–large | Example on `booking.cancelled_*` webhooks; not core |
| Waivers | Tours | Table stakes [A] | — | Example: link a waiver service in the confirmation email |
| SMS reminders | Restaurants, fitness, tours | Table stakes [A], usually per-message fees | Small as an adapter | Durable hook example; not core |
| Check-in / manifest app | Tours | Table stakes [A] | Medium | Not examined further; the plan rejected an admin day view (item 22) |
| Packs, memberships, card on file, no-show fees | Fitness studios | Table stakes there [A] | Large, a different model | **Nowhere.** Classes beyond drop-ins are not Reserva's market |
| Floor plans / table assignment | Restaurants | Table stakes there [A] | Assigned seating is a non-goal | **Nowhere.** Restaurants beyond "covers per seating" are not Reserva's market |
| Reserve with Google End-to-End | Restaurants, appointments | Table stakes there [A] | Impractical: needs a contract with every merchant, a <1 s booking server, ≥90% success [A] (https://developers.google.com/actions-center/verticals/reservations/e2e/policies/integration-policies) | **Nowhere** |
| Google Things to do links | Tours | Free, redirect-only [A] (https://developers.google.com/actions-center/verticals/things-to-do/overview) | Small: feed from the catalog, but needs Google approval or a partner | Docs/example |
| OCTO / GetYourGuide connectivity | Tours selling through resellers | Differentiator | Medium after conclusion 4 + ticket types + per-reseller keys. OCTO `ON_HOLD`+`expirationMinutes`→`/confirm` maps onto Reserva holds [V] (https://docs.octo.travel/octo-api-core/bookings); GetYourGuide allows single-company integrations [A] (https://www.getyourguide.supply/connectivity/partners-faqs) | Separate package, later |
| MCP server | Agent channels | Differentiator [A] | Small | Example (Q2) |
| Included API + webhooks | — | **Reserva already wins.** Rezdy paywalls the API at $249/mo [A] (https://www.rezdy.com/pricing/) | — | Say it in the README |
| Customer self-cancel/reschedule, multi-language | — | Table stakes; **Reserva has them** [V] | — | — |

### Positioning notes

- **Say "no platform fees", not "no per-booking fees".** Stripe's fees still apply [A] (https://stripe.com/pricing).
  - Strongest against tour platforms: Rezdy 3%, Bókun 1–1.5%, Checkfront €99 + 3%; FareHarbor's customer-paid fee [V] (https://fareharbor.com/legal/tos-customers/).
  - Weak in restaurants, where Resy, SevenRooms and resOS already say it [A].
- **Self-hosted scheduling is in flux.**
  - Cal.com went closed source on 2026-04-14, and `calcom/cal.com` now redirects to the MIT `calcom/cal.diy` [V] (https://cal.com/blog/cal-com-goes-closed-source-why, https://github.com/calcom/cal.diy).
  - No other self-hosted, edge-native *capacity-slot* engine turned up [A]; the Cloudflare-native entrants are appointment schedulers.
- **Restaurant platforms are shifting.** Quandoo shut down in 2026 [A] (https://www.quandoo.fi/en/important-update). This doesn't change the verdict on restaurants.

### Verticals

| Vertical | Verdict |
|---|---|
| **Tours/activities** | Best fit: scheduled departures, shared capacity, pickups, self-service, high incumbent fees. Gaps: pools, staff bookings/deposits, promo codes, then ticket types |
| **Classes** | Partial fit: drop-in classes only. Studios run on packs and memberships |
| **Restaurants** | Weak fit beyond "covers per seating with a deposit" |
| **Venue hire** | Poor fit: approval flows and multi-day bookings are non-goals |

---

## Examined and left alone

| Item | Why it stays |
|---|---|
| Durable Objects for capacity | D1's single-writer guard is already correct, and a DO would split capacity from the outbox batch |
| Queues or Workflows replacing the outbox | No Cloudflare primitive gives a transactional outbox [A]; the D1 outbox is the right design |
| D1 read replication | No read-latency problem, and it adds consistency questions |
| Postgres support | It changes the concurrency model, not just the dialect; there's no audience signal for it |
| Multi-day rentals, assigned seating, per-staff scheduling | Non-goals; the research confirms they are other markets |
| Reserve with Google End-to-End | Impractical for a single business [A] |
| Secrets Store, Containers, Workers for Platforms, Hyperdrive | No problem to solve unless the product goes hosted |
| A second payment adapter | Keep Stripe as the only shipped adapter. Conclusion 4 adds payment *modes*, not providers |
| The `src/repo.ts` split | Its trigger is fine, and a port would cut below it. ~~Only the "~59" count in `docs/architecture.md:79` needs updating to 81~~ (updated) |
| Built-in Access via `ctx.access` | The current verifier works [A] |
| Memberships/packs, floor plans, gift-card ledgers | Other products' core models |

---

## Questions only you can answer

1. **Is a hosted or multi-tenant Reserva ever intended?** If yes, Postgres, Workers for Platforms and a login-based admin come back into scope. If no, conclusion 7 holds.
2. **Free plan or Workers Paid as the supported baseline?** This decides whether conclusion 3 is a code fix or a README line.
3. **Will you ship a widget (as a separate package) and a standalone template?** That reverses the spirit of "no funnel UI" while keeping the package itself headless.
4. **Are staff/phone bookings and capacity pools now in scope?** They reverse two planning rules (`implementation-plan.md:12`, item 18).
5. **Is reseller distribution (OCTO, GetYourGuide) a goal?** If yes, ticket types move up behind pools.
6. **Which vertical do you sell to first?** The ranking above assumes tours/activities.
7. **Would you accept an admin login beyond Access?** It only matters if a non-Cloudflare port ever happens.

---

*Measurement script: `docs/tmp/growth-analysis-sweep-queries.ts` (counts against the in-memory fake; not run on real D1). The real-D1 figures in conclusion 3 come from `tests/workers/reconciliation-query-budget.test.ts`.*

---

## Decisions (triage with the maintainer, 2026-10-01)

Context from the maintainer: Reserva is not becoming a business. The goal is to make it viable and pleasant for anyone who wants to use it — UX, usability, features. Reseller/OTA distribution (OCTO, GetYourGuide) is out. Hosted/multi-tenant: undecided, assume no. Free plan is the baseline.

Done (PR #31): capacity `occupancy` made explicit (conclusion 1); alerts follow the admin-edited contact email (conclusion 6, bug part).

| # | Item | Decision | Notes |
|---|---|---|---|
| 1 | Let any website use Reserva | ~~**Build CORS now.**~~ Done: `routes.cors.origins`. Template + widget: later | CORS = config allowlist of origins, `OPTIONS` on customer routes only |
| 2 | ~~Sweep over Free plan's 50 D1 queries after an outage~~ | ~~**Build now**~~ Done | `ReconciliationOptions.queryBudget`, default `DEFAULT_RECONCILIATION_QUERY_BUDGET` (36). Each step is admitted only if its worst case fits; one alert and the lease release are always kept back. Pinned on real D1 by `tests/workers/reconciliation-query-budget.test.ts` |
| 3 | Bookings not paid through Stripe Checkout | **Later** (all three) | Order when picked up: admin "add booking" (paid offline, same capacity guard) → pay on arrival per service (+ contact fields on checkout) → deposits. Reverses the "no operator-created bookings" planning rule |
| 4 | Capacity pools per service | **Later** | Trigger: a deployment with services that don't share resources. Shape: `pool` key on capacity tables + bookings, `AND pool = ?` in the guard, per-pool admin capacity. No auto-assignment. Reverses plan item 18 |
| 5 | Framework-agnostic `fetch`/`scheduled` handler, Astro as adapter | **Later, on request** | Trigger: a non-Astro (Hono, React Router, TanStack, vinext) user asks. With CORS, non-Astro sites can already call a standalone Reserva |
| 6 | Bots holding all capacity | ~~**Build now:** default `booking.maxHoldsPerIp` (e.g. 5).~~ Done: default 5, `null` removes it. **Later:** opt-in Turnstile on checkout | ~~Today the cap is off unless configured (`src/handlers/checkout.ts:282`)~~; each hold blocks capacity ≥35 min |
| 7 | Built-in admin login (magic link via the email provider) | **Later, planned** (after CORS and small fixes) | Allowed emails in config, signed session cookie, Access stays as alternative. Needs `AdminAuth` able to redirect. Reverses plan item 11 |
| 8 | ~~Missing type exports (`CancelRequest`, `RescheduleRequest`, `ApiErrorDetails`)~~ | ~~**Build now**~~ Done | Exported from `@reservajs/astro/core` |
| 9 | Pre-hold hook (reject/adjust a checkout) | **Later, on request** | Trigger: a user hits a rule config can't express. A min party size alone would be a `minQuantity` config key, not a hook |
| 10 | Promo codes | **Later, planned** | Discount applied at hold time so the stored `priceMinor` is already discounted and `verifyPayment`'s exact match holds; Stripe-side promotion codes would break it. Admin CRUD (percent/fixed, expiry, max uses), `code` on quote + checkout, atomic usage counter |
| 11 | Setup weight; ~~required Cloudflare plan undocumented~~ | ~~**Build now:** "runs on the Workers Free plan" in README + `docs/deployment.md`.~~ Done: README + "Which Workers plan" in `docs/deployment.md`. Setup weight: covered by items 1 (template) and 7 (login) | Paired with item 2, so the claim holds after an outage |
| 12 | ~~`docs/architecture.md:79` says ~59 repo methods; there are 81~~ | ~~**Build now**~~ Done | Doc-only |
| 13 | MCP server example | **Later, low priority** | `examples/` only, over the public API (catalog, availability, quote, checkout link) |
| 14 | Cloudflare Email Sending adapter | **Later, with trigger** | Trigger: Email Sending leaves beta or reaches the Free plan (today: public beta, Workers Paid, Cloudflare DNS required) |

### Build queue (from the decisions above)

All done in PR #31, each with a changeset in `.changeset/`.

1. ~~Default `booking.maxHoldsPerIp` (item 6) — tiny~~
2. ~~Export the three missing types (item 8) — tiny~~
3. ~~Repo method count in `docs/architecture.md` (item 12) — tiny~~
4. ~~"Runs on the Workers Free plan" in README + deployment guide (item 11) — tiny~~
5. ~~Sweep query budget per invocation (item 2) — small~~
6. ~~CORS allowlist for customer routes (item 1) — small~~

### Planned later

- Admin login via magic link (item 7)
- Promo codes (item 10)
- Deploy template, then drop-in widget (item 1)
- Admin "add booking" → pay on arrival → deposits (item 3)
- Capacity pools (item 4, on trigger)
- Turnstile on checkout (item 6)
- Framework-agnostic handler (item 5, on request); pre-hold hook (item 9, on request)
- MCP example (item 13, low priority); Email Sending adapter (item 14, on trigger)
