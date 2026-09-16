# Implementation plan — library improvements

Future-state plan for `@reservajs/astro` and `@reservajs/stripe`, derived from
`docs/tmp/lib-review-2026-09-16.md` and decided item by item on 2026-09-16. Nothing below is built yet. Every
`file:line` reference is against `main` at commit `5b9c537`. Target release: 0.5.0 (breaking; changesets per item).
External claims validated 2026-09-16 against Stripe, Astro, Cloudflare and Brevo docs; findings folded into items 2,
12, 13 and 20. Versions at validation: stripe 22.6.2 (installed ^22.5.0), @astrojs/cloudflare 14.3.1, astro 7.3.2,
wrangler 4.132.0, cally 0.9.2.

**Product rules fixed during planning.** Cloudflare Access is the only production admin auth. No delayed payment
methods. One shared capacity pool. Breakpoint pricing only. The admin dashboard is the source of truth for prices,
hours, capacity and policy; static sites rebuild from the catalog on `settings.changed`. No operator-created
bookings. Lean over general: each item ships the smallest change that closes the gap.

**Sequencing.** See "Phases" at the end; items are numbered in decision order, not build order.

## 1. Schedule rules combine instead of first-match

**Current state.** `scheduleForDate` (`src/core/slots.ts:25-28`) returns the first rule matching weekday + season;
`generateSlots` uses only that rule. Callers: `generateSlots`, `occupancy.ts:326` (day-open check),
`availability.ts:213`, `checkout.ts:154`. Validation (`config.ts:373-386`) checks rules in isolation.
Split days (`examples/configs/fitness-studio.ts:22-25`) silently lose every rule after the first.

**Decision.** Union semantics. Every rule matching the date contributes slots.

**Changes.**
- `slots.ts`: replace `scheduleForDate` with `scheduleRulesForDate(service, date, tz): ScheduleRule[]`.
  `generateSlots` generates from each rule, dedupes on identical `start`, sorts ascending.
- `occupancy.ts:326`: day-open check becomes `scheduleRulesForDate(...).length === 0`.
- `config.ts` validation: new cross-rule check. Two rules that share a weekday, have overlapping seasons, and
  produce the same start time fail with a message naming both indices
  (`services.<slug>.schedule.<i>` and `.<j>`). Overlapping windows with distinct starts are legal.
- Settings page (`settings.ts:189`) edits rules by index; unaffected.

**Tests.**
- fitness-studio config yields 07,08,09,18,19,20 on a weekday.
- Duplicate start across two rules fails validation; distinct starts (09:00/09:30 hourly) pass.
- Existing seasonal tests in `tests/core-slots.test.ts` keep passing.

**Out of scope.** Blackout dates and "season overrides base rule" semantics; separate item.

## 2. Stripe: dashboard-managed payment methods, no delayed methods

**Current state.** `packages/stripe/src/provider.ts:70` limits `paymentMethods` to `'card' | 'mb_way'` and `:349`
sends it as `payment_method_types`, overriding the Stripe dashboard. A delayed method (Multibanco, SEPA) yields
`checkout.session.completed` with `payment_status: 'unpaid'`; `verifyPayment` returns `payment_not_paid` and
`handlers/webhook.ts:33-35` answers `409 payment_amount_mismatch`. `async_payment_succeeded/failed` are unmapped
(`provider.ts:254-255`). Stripe docs (2026-09): omit `payment_method_types` and manage methods in the dashboard;
Multibanco vouchers live 7 days + 4-day buffer and never redirect to `success_url`.

**Decision.** Use Stripe's dynamic payment methods. Delayed methods are unsupported and are refused safely.

**Changes.**
- Remove `paymentMethods`, `StripePaymentMethod`, `stripePaymentMethodTypes`; stop sending `payment_method_types`.
  Apple Pay, Google Pay, Link come from the dashboard. Changeset: breaking for the adapter option.
- Send `excluded_payment_method_types` with the curated delayed-notification types, kept in one exported constant
  `STRIPE_DELAYED_PAYMENT_METHOD_TYPES`. Stripe has no canonical "delayed" enumeration, so the list is curated from
  the per-method pages (2026-09): bank debits `us_bank_account`, `sepa_debit`, `bacs_debit`, `au_becs_debit`,
  `nz_bank_account`, `acss_debit`; bank transfer `customer_balance`; vouchers `boleto`, `konbini`, `multibanco`,
  `oxxo`. Never include `apple_pay`, `google_pay` or `link`: Stripe rejects them in this parameter. Verified
  2026-09: the parameter exists and is meant for dashboard-managed methods. This is a cheap guard for a dashboard
  that enables a delayed method by mistake; the webhook handling below is the backstop. (`allowed_payment_method_types`
  exists as an allowlist alternative; rejected because it would block any new dashboard method until the library
  lists it.)
- Send `submit_type: 'book'` so the Stripe button reads "Book".
- `createCheckout` returns `{ url, sessionRef, expiresAt }` (ISO); Stripe fills it from the session's `expires_at`
  (30 min–24 h window, already satisfied by `max(30, holdMinutes − 5)`).
- `PaymentProvider` gains optional `cancelPayment?(paymentRef: string): Promise<void>`, best-effort by contract.
  Stripe implements it with `paymentIntents.cancel` and treats any Stripe error as a no-op with a warn log. Verified
  2026-09: after `checkout.session.completed` the session is `complete`, so `sessions.expire` is unavailable, and
  `paymentIntents.cancel` is only documented to work for a Checkout PI in `requires_capture`; the Multibanco page
  says vouchers (PI `requires_action`) can be cancelled, `processing` debits (SEPA/ACH) cannot. So cancel usually
  works for vouchers and usually fails for debits; the `async_payment_succeeded` path below covers the rest.
- `handlers/webhook.ts`, `checkout_completed` with `paid === false`: do not verify. Instead `expireHold`, call
  `cancelPayment` when the provider has it (log error if absent or it throws), reply 200, `logger.warn`
  `'delayed payment method refused'` with `{ bookingId, paymentStatus }`. Existing `payment_not_paid` 409 path becomes
  unreachable for this event and is removed.
- Map `checkout.session.async_payment_succeeded` → new parsed type `'async_payment_succeeded'`. Handler: the hold was
  already released, so validate session/amount/currency, record a full refund in `refund_operations` against the
  event's `paymentRef`, and call the existing idempotent `refund` port immediately. Reply 200 once the row is
  durable. A failed attempt follows the existing refund retry loop and `refund` incident projection
  (`reconciliation.ts:154-174`); no bespoke "refund manually" incident. Map `async_payment_failed` →
  `checkout_expired` (idempotent hold release).
- Customer copy for the refused path (confirmation `failed` state from item 4, and any email sent for it): say the
  payment method is not accepted, the booking was not made, any voucher or bank instructions are void, and that a
  payment already sent will be refunded.
- Docs (`packages/stripe` README + deployment.md): "Reserva does not support delayed payment methods. Do not enable
  Multibanco, SEPA Direct Debit, or bank transfer in the Stripe dashboard." Add the four webhook event types to the
  subscription list.
- mazetours: drop `paymentMethods: ['card', 'mb_way']` on upgrade.

**Tests.** Unpaid completed event → hold expired, cancelPayment called, 200; cancelPayment throwing still gives
200. async_payment_succeeded → `refund_operations` row + `refund` call, no incident; refund throwing → row stays
pending and the normal retry/incident path picks it up.
Session create params carry no `payment_method_types` and carry `excluded_payment_method_types` equal to the
constant.

**Out of scope.** Real delayed-method support (multi-day holds, "awaiting payment" confirmation state).

## 3. Localized, required service titles surfaced on the wire

**Current state.** `ServiceConfig.title` is `string | undefined`; meeting point `label`, pickup `label`/`hint` are
plain strings. Only `metadataFields[].label` is `LocalizedText` (`config.ts:67-79`, resolver at `config.ts:569`).
Fallback `title ?? slug` in `catalog.ts:81`, `email/render.ts:77`, `admin-page.ts:204`, `settings.ts:194,241`.
Manage page (`manage-page.ts:63`) and confirmation page/ICS (`confirmation-page.ts:52-53`) render `serviceSlug`
directly. `ManageBooking`/`ConfirmationBooking` (`api.ts:143,160`) carry no title.

**Decision.** `LocalizedText` everywhere a human reads it; `title` required; `serviceTitle` on every wire shape.

**Changes.**
- `config.ts`: `title: localizedTextSchema` (required); `meetingPoints[].label`, `pickupOptions[].label`,
  `pickupOptions[].hint` → `localizedTextSchema`. Rename `resolveMetadataFieldLabel` → `resolveLocalizedText`
  (keep the old name as an alias for one release). Add `resolveServiceTitle(config, slug, locale)`.
- Wire: `serviceTitle: string` added to `WireBooking`, `ConfirmationBooking`, `ManageBooking`, `CatalogService`
  (already has `title`, now locale-resolved). Resolved for the booking's `locale`; catalog/webhook use the request
  locale / `locales.default`. `apiVersion` unchanged: additive field.
- Renderers: manage page facts, confirmation facts (add a service row), ICS `SUMMARY`, Google Calendar link, admin
  rows, admin search haystack, settings groups, email `serviceTitle` all read the resolved title. Slug fallbacks
  deleted.
- `@reservajs/stripe`: default line-item name is `serviceTitle`; `getServiceName` stays as an override. Remove
  the other four aliases (see item on option aliases when decided).
- Catalog: meeting point and pickup labels resolved per request locale (they are already per-locale in
  `CatalogLocation`? verify; if not, resolve there too).
- Docs: AGENTS.md config table (`title` required, `LocalizedText`), README quickstart unchanged (already has a title).
- Changeset: breaking (required `title`).
- mazetours: delete `tourName()` and `getServiceName`; set `title: { en, 'pt-PT' }` per service.

**Tests.** Config without `title` fails with path `services.<slug>.title`. pt-PT request → pt-PT title in catalog,
manage, confirmation, email. Plain-string labels still accepted.

## 4. Confirmation page: bounded polling and a `failed` state

**Current state.** `confirmation-page.ts:93` meta-refreshes every 3 s while `status === 'pending'`, unbounded.
`status-manage.ts:108-110` reports a rejected verification (session complete, payment not acceptable) as
`pending` with `booking: null`. No contact details on the page. `StatusState` (`api.ts:150`) has no failure value.

**Decision.** 60-second cap, then a "still processing" page. New `failed` status for rejected verification.

**Changes.**
- `StatusState` gains `'failed'`. `handleStatus`: when `session.status === 'complete'` and verification is rejected,
  return `{ status: 'failed', booking: null }`, log warn (already), and open an operational incident
  (`payment_verification_rejected`, severity high, with `bookingId`, `reason`) so it shows on the admin dashboard.
  With item 2, `payment_not_paid` on the status path also expires the hold and calls `cancelPayment`.
- Confirmation route: read `attempt` from the query string (default 0). While `pending` and
  `attempt < 20`, refresh to `…&attempt=N+1`. At 20 (≈60 s), render `confirmation.pendingTimeoutTitle/Body`
  ("We're still waiting for the payment provider. You'll get an email once it's confirmed."), a contact block, and a
  "Check again" link to `attempt=0`.
- `failed` page: `confirmation.failedTitle/Body` ("We couldn't confirm your payment and no booking was made. Any
  voucher or bank instructions you received are void; if a payment does go through it will be refunded. Contact
  us and we'll sort it out.") plus the contact block. No start-over button. Wording covers the delayed-method
  refusal from item 2, where a Multibanco voucher may already be in the customer's hands.
- Shared `contactBlock(config, messages)` in `src/ui/layout.ts`: email (`mailto:`), phone (`tel:`), WhatsApp
  (`https://wa.me/<digits>`). Used by confirmation (`pending timeout`, `failed`, `expired`) and manage (past
  cutoff "contact us", invalid token) pages.
- Messages: 4 new keys in `messages.ts` and `pt-PT.json`; `confirmation.pendingBody` unchanged.
- Docs: `StatusState` list in api.md/AGENTS.md; note `failed` is terminal for the customer.

**Tests.** Unit: `attempt=20` renders timeout copy, no refresh tag. Handler: complete+rejected → `failed` +
incident row. e2e: `failed` and timeout pages contain contact email.

## 5. No magic pickup ids; pickup labels required

**Current state.** `catalog.ts:26-31`, `admin-page.ts:212-215`, `settings-page.ts:79`, `manage-page.ts:75` special-case
ids `'default'` and `'custom'` (catalog copy from `widget.pickupDefault/Custom(+Hint)`, and `custom` ⇒ "has address"
even when the option is unknown). `pickupOptions[].label` is optional, so other ids render raw. The implied option
`{ id: 'meeting_point' }` (`config.ts:102`) has no label either.

**Decision.** Ids are opaque. Labels are required and localized. Address handling keys off `requiresAddress` only.

**Changes.**
- `config.ts`: `pickupOptions[].label: localizedTextSchema` required; `hint` optional localized. The implied
  `meeting_point` option gets `label` from a new message key `pickup.meetingPoint` ("Meeting point") resolved per
  locale at catalog/render time (only place a message key is used for a pickup label).
- Delete the `default`/`custom` branches in the four files. Admin/manage "address" rows render when the resolved
  option's `requiresAddress` is true; unknown option (stale booking) → show raw `pickupType`, no address row.
- Remove `widget.pickupDefault`, `widget.pickupDefaultHint`, `widget.pickupCustom`, `widget.pickupCustomHint`
  from `messages.ts` and `pt-PT.json`; update `examples/smoke-site/src/components/BookingWidget.astro` and
  `examples/configs/*` to declare labels.
- Validation message on missing label: `services.<slug>.location.pickupOptions.<i>.label: required`.
- Changeset: breaking.

**Tests.** Config with `id: 'custom'` and no label fails validation. Catalog returns declared labels per locale;
implied option returns "Ponto de encontro" for pt-PT.

## 6. Validation messages name the field; structured `details`

**Current state.** Public-endpoint `validation_failed` messages without a field name: `'Unknown service'`
(`availability.ts:153`, `checkout.ts:213`, `quote.ts:16`), `'No price is configured for this party size'`
(`availability.ts:168`), `'…party and pickup type'` (`checkout.ts:42`), `'Date range is empty'`
(`availability.ts:192`), `'Unknown meetingPointId'` (`checkout.ts:56`). Cancel CAS loss after a concurrent
reschedule returns `slot_unavailable` (`booking-actions.ts:51`). Envelope is `{ error: { code, message } }` only.

**Decision.** Rewrite the five; add optional `details`; fix the cancel code. Admin-form messages unchanged.

**Rewrites (developer-facing, start with the field name like existing messages).**
- `serviceSlug must be one of: <declared slugs>`
- `quantity <n> has no pricing rule for service <slug>; maximum is <max maxQuantity>`
- `quantity <n> with pickupType <id> has no pricing rule for service <slug>`
- `from/to contain no days; check the dates and the booking horizon`
- `meetingPointId must be one of: <declared ids>`

**Envelope.** `ApiErrorEnvelope.error.details?: { field?: string; allowed?: string[] }`. `HttpError` gains an
optional `details` arg; the five messages above and the existing `${field} must be one of` (pickup) and metadata
`select` messages populate it. Additive; `apiVersion` unchanged. Documented in api.md/AGENTS.md.

**Cancel race.** `booking-actions.ts:51` → `409 invalid_transition`, message
`booking was rescheduled; reload and try again`.

**Tests.** Each rewritten path asserts message prefix and `details.allowed`. Cancel-after-reschedule asserts code.

## 7. One vocabulary across endpoints

**Current state.** `?service=` (`availability.ts:152`) vs `serviceSlug` (quote/checkout); `pickup`
(`QuoteRequest`, `CatalogPricingRule`) vs `pickupType` (`CheckoutRequest`, `WireBooking`, `ManageBooking`);
`start` (checkout) vs `newStart` (`booking-actions.ts:61`); `?session_id=` (`status-manage.ts:85`).

**Decision.** `serviceSlug`, `pickup`, `start`, `sessionId`. `startsAt` remains the booking-record field.
`token` / `operatorToken` + `bookingId` unchanged. Webhook envelope booking keeps `pickupType` (frozen by docs).

**Changes.**
- Availability: read `serviceSlug`, fall back to `service`. Status: read `sessionId`, fall back to `session_id`.
  Stripe adapter `defaultSuccessUrl` emits `sessionId={CHECKOUT_SESSION_ID}`.
- Checkout body: read `pickup`, fall back to `pickupType`. Reschedule body: read `start`, fall back to `newStart`.
- Response types: `ManageBooking.pickup` (was `pickupType`); `ConfirmationBooking` likewise if present.
  `WireBooking` (webhook payload) unchanged.
- Fallback reads log `logger.warn('deprecated field', { endpoint, field })` once per isolate per field.
- Types: `CheckoutRequest.pickup`, `RescheduleRequest.start` (add the missing `RescheduleRequest`/`CancelRequest`
  types to `api.ts`); old names removed from the types immediately.
- Docs: api.md, AGENTS.md, README route notes. Changeset: minor with deprecation note; removal of fallbacks in the
  following minor.
- mazetours funnel: rename in the checkout payload and availability query.

**Tests.** Each endpoint accepts both spellings; response snapshot uses the new names.

## 8. `@reservajs/astro/client` — typed browser-safe client

**Current state.** No client. Reference widget hand-rolls `Fallible<T> = Partial<T> & Partial<ApiErrorEnvelope>`
(`examples/smoke-site/src/components/BookingWidget.astro:232`) and raw `fetch` per endpoint; mazetours does the same
and mistyped the slot shape. Endpoint paths come from `virtual:reserva/config` (`ReservaResolvedRouteConfig.paths`).

**Decision.** Ship `src/client/index.ts`, exported as `./client`. Imports only `src/core/api.ts` types and
`API_ERROR_CODES`. No Astro, no Node, no Cloudflare imports (guarded by a pack-fixture browser bundle test).

**API.**
```ts
createReservaClient(options: {
  paths?: Pick<ReservaResolvedRouteConfig['paths'], 'availability' | 'checkout' | 'quote' | 'catalog' | 'status'
    | 'manageApi' | 'cancel' | 'reschedule' | 'operatorCancel' | 'operatorReschedule' | 'operatorNoShow' | 'opsHealth'>;
  base?: string;            // alternative to paths: route prefix, default ''
  fetch?: typeof fetch;     // default globalThis.fetch
  bearer?: string;          // operator/ops routes
}): ReservaClient

interface ReservaClient {
  catalog(q?: { locale?: string }, init?: { signal?: AbortSignal }): Promise<CatalogResponse>;
  availability(q: { serviceSlug; quantity; from; to }, init?): Promise<AvailabilityResponse>;
  quote(body: QuoteRequest, init?): Promise<QuoteResponse>;
  checkout(body: CheckoutRequest, init?): Promise<CheckoutResponse>;
  status(q: { sessionId }, init?): Promise<StatusResponse>;
  manage(q: { token }, init?): Promise<ManageResponse>;
  cancel(body: CancelRequest, init?): Promise<ManageActionResponse>;
  reschedule(body: RescheduleRequest, init?): Promise<ManageActionResponse>;
  operator: { cancel(body), reschedule(body), noShow(body) }; // bookingId + bearer, or operatorToken
  opsHealth(init?): Promise<OpsHealthResponse>;
}
class ReservaApiError extends Error { status: number; code: ApiErrorCode; details?: { field?; allowed? } }
isReservaApiError(value: unknown): value is ReservaApiError
```
- Non-2xx with a parseable envelope → `ReservaApiError`. Non-2xx without envelope, or network failure → rethrown
  as `ReservaApiError` with `code: 'internal_error'` and the HTTP status (0 for network).
- `paths` and `base` are mutually exclusive; both absent → `base: ''` with manifest defaults. Manifest patterns are
  imported from a tiny `src/core/route-paths.ts` (pattern table without `entrypoint`, no Astro import) so the
  client stays Astro-free; `routes-manifest.ts` re-uses that table.
- Uses the item-7 field names. Sends `Content-Type: application/json`, `Accept: application/json`,
  `cache: 'no-store'` on availability/status/manage.

**Consumers.** Reference widget and `ManageBooking.astro` enhancer switch to it. mazetours funnel switches to it.
Docs: new section in api.md; AGENTS.md quickstart shows the client for the funnel.

**Tests.** Unit with a fake `fetch`: each method's URL/body, error mapping, `base` vs `paths`. Component test that
the module bundles for the browser with no Node built-ins.

## 9. Export presentation helpers; richer slots; calendar helpers

**Current state.** `src/ui/format.ts` (`formatDateTime`, `formatDayDate`, `formatDateParts`, `formatPrice`,
`googleCalendarUrl`, `icsDataUrl`, `CalendarEvent`) is internal; `./ui` exports only `messages.ts`.
`AvailabilitySlot` is `{ start, remaining }` (`api.ts:60`) although `GeneratedSlot` has `localDate`/`localTime`.
`quantity` is required on availability (`availability.ts:154`). Widget slices `start.slice(11,16)` and rewrites
`isDateDisallowed`/`openDays[0]`.

**Decision.** Export as is; add `date`/`time` to slots; helpers in `./client`; `quantity` optional (default 1).

**Changes.**
- `src/ui/index.ts` becomes the `./ui` entry: re-exports `messages.ts` and `format.ts`. package.json `./ui`
  points at it. `formatDayDate` gains `year: 'numeric'` when the date's year differs from the current year
  (fixes the New-Year ambiguity; pass `now` for testability).
- `AvailabilitySlot` → `{ start, date, time, remaining }` with `date` = business-local `YYYY-MM-DD`,
  `time` = `HH:MM`. Additive.
- Availability handler: `quantity` absent → 1. Docs updated; `assertSupportedPartySize` unchanged.
- `src/client/availability.ts` (re-exported from `./client`):
  `openDays(r): AvailabilityDay[]`, `firstOpenDay(r): AvailabilityDay | null`,
  `isDayDisallowed(r): (date: Date) => boolean` (UTC getters, matching cally's `Date.UTC` dates),
  `horizonRange(catalog: Pick<CatalogResponse,'maxHorizonDays'>, today: string): { from; to }`.
  `dateKey(date: Date): string` (UTC-based) exported too.
- Widget, `manage-enhancer.ts` and `ManageBooking.astro` use the helpers; slice/dateKey duplicates removed.

**Tests.** Slot `date`/`time` for a DST-crossing date. `quantity` omitted → same as 1. Helpers unit-tested with a
fixture response. `formatDayDate` shows the year for a next-year date only.

## 10. Response contract gaps

**Current state.** `CheckoutResponse` = `{ checkoutUrl, bookingId, reference }` (`api.ts:118`). `QuoteRequest.locale`
accepted and ignored (`api.ts:93`). `ManageResponse.deadline` is always the cancel cutoff (`status-manage.ts:186`).
`StatusResponse.booking` is `null` after 4 h (`status-manage.ts:80,145`).

**Decision.** Add `paymentDeadline`, `rescheduleDeadline`, a minimal post-grace status booking; drop `QuoteRequest.locale`.
Unit price on quote waits for per-person pricing (later item).

**Changes.**
- `CheckoutResponse.paymentDeadline: string` (UTC ISO) = provider `expiresAt` from item 2, falling back to the hold
  expiry. Documented: "the payment page closes at this instant; the hold may outlive it by a few minutes".
- `ManageResponse`: `cancelDeadline` (new name) and `rescheduleDeadline` (from `booking.reschedule.cutoffHours`).
  `deadline` kept for one minor as an alias of `cancelDeadline`, then removed.
- `StatusResponse` after the 4-hour grace: `{ status: 'confirmed', booking: { reference, serviceTitle, start, end,
  locale } }` — a new `ConfirmationSummary` shape; personal details, price, pickup, metadata stay withheld.
  `ConfirmationBooking` extends it. Confirmation page renders the summary variant with "details were emailed".
- `QuoteRequest.locale` removed from the type; handler ignores it silently (no error) for one minor.
- Docs: api.md endpoint notes and AGENTS.md.

**Tests.** Checkout response carries `paymentDeadline` ≤ hold expiry. Manage with distinct reschedule cutoff returns
two deadlines. Status at 5 h returns the summary with reference and no email.

## 11. Admin auth: Cloudflare Access only, automatic dev bypass

**Current state.** `resolveAdminAuth` (`runtime-context.ts:131-152`) requires exactly one of `config.admin.access`
or a custom `adminAuth`. Access cannot protect `localhost`, so every consumer writes a fake `adminAuth` for dev
(`examples/smoke-site/src/runtime.ts:153`, mazetours `reserva-runtime.ts:29-38`) and must swap it out with the
`access` block at cutover. `virtual:reserva/config` carries `{ paths, groups }` only (`routes-manifest.ts:80`);
the integration sees Astro's `command` at `astro:config:setup` but does not forward it.

**Decision.** Keep Access as the production path and the exactly-one rule. No password auth, no `Response`
return. Dev bypass derived from the build command, never from runtime env.

**Changes.**
- `ReservaResolvedRouteConfig` gains `dev: boolean`, set from `command === 'dev'` in `integration.ts:142`.
  `astro build` and `astro preview` emit `false`.
- Admin gate (`handlers/admin.ts:41,126` and the operator routes' shared gate): if `routeConfig.dev` is true and
  `config.admin.access` is set, resolve `{ subject: 'dev' }` without calling Access, and `logger.warn` once per
  isolate: `'admin auth bypassed: astro dev'`. A custom `adminAuth` is still called in dev (its author owns it).
- Docs (`deployment.md` "Admin access"): remove the "pass a custom adminAuth for local dev" paragraph; state the
  bypass and that it exists only in `astro dev` output.
- Smoke site: drop the fake `adminAuth`, set `admin.access` with placeholder values. mazetours: at cutover, add
  `admin.access` and delete `admin-demo-auth.ts`, `admin-login.ts`, the middleware redirect and the `adminAuth`
  option; until cutover nothing changes.

**Tests.** Integration test: `command: 'dev'` → virtual config `dev: true`; `build` → `false`. Handler test:
`dev: true` + access configured → 200 without a JWT; `dev: false` → 403.

## 12. Setup boilerplate: single config source, default entrypoint, no vendor env names

**Current state.** `reserva({ config, runtimeEntrypoint })` validates config (`integration.ts:120-126`) and
serializes only `{ paths, groups }` into `virtual:reserva/config`. `defineCloudflareReservaRuntime(config, options)`
validates it again (`runtime-context.ts:185`). `ServiceConfig.occupancyFor` is a function (`occupancy.ts:132`),
the one non-JSON member (`settings.ts:304` has to shallow-clone because of it). `runtimeEntrypoint` is required
(`integration.ts:20`). `reservaSecretEnvSchema` (`integration.ts:32-39`) declares `STRIPE_*`, `BREVO_*`, `GOOGLE_*`.

**Decision.** Declarative occupancy; config travels through the virtual module; entrypoint defaults; core env
schema lists only `RESERVA_*`.

**Changes.**
- `ServiceConfig.occupancy?: { seatsPerUnit: number }` (positive integer). Units = `ceil(quantity / seatsPerUnit)`;
  absent ⇒ 1 unit per booking. `occupancyFor` removed; `occupancy.ts:132` computes from the data. Validation error
  for a function: `services.<slug>.occupancyFor: replaced by occupancy.seatsPerUnit`.
- `virtual:reserva/config` becomes `{ config: ResolvedClientConfig, routes: { paths, groups, dev } }`. Type
  declaration injected accordingly; `virtual.d.ts` updated. The client (item 8) reads `routes.paths`.
- `defineCloudflareReservaRuntime(options)` and `defineReservaRuntime(options)` drop the config argument and import
  it from `virtual:reserva/config`. `ReservaContextInput.config` stays. Consumers' `reserva.config.ts` is now
  imported only by `astro.config.ts`.
- The `scheduled` handler (item 13) lives in the site Worker's custom entry, which Astro/Vite bundles, so it reads
  the same virtual module; no config override is needed for cron.
- `runtimeEntrypoint` optional, default `./src/reserva-runtime.ts` (resolved against `config.root`); missing file
  still throws with the resolved path.
- `reservaSecretEnvSchema` keeps `RESERVA_OPERATOR_SECRET` and adds `RESERVA_CSRF_SECRET`,
  `RESERVA_TOKEN_ENC_KEY`; vendor names removed. `@reservajs/stripe` README shows the consumer adding its own
  `env.schema` entries if they want typed access.
- README quickstart, AGENTS.md, examples, MIGRATING doc updated. Changeset: breaking.
- mazetours: `occupancy: { seatsPerUnit: SEATS_PER_TUKTUK }`; runtime file drops the config import and argument.

**Tests.** Occupancy unit math (quantity 5, seatsPerUnit 4 → 2). Integration test asserts the virtual module
carries the resolved config. Runtime definition without config arg boots in the pack fixture.

## 13. Reconciliation route; `scheduled` in the site Worker

**Current state.** `@astrojs/cloudflare` 14.3.1's default entry exports only `fetch` (adapter dist
`entrypoints/server.js`), and `docs/deployment.md` step 8 therefore requires a second Worker that bundles the
consumer's runtime module and repeats every secret. Verified 2026-09 that this premise is outdated: the adapter
honours a custom `main` in `wrangler.jsonc` (`dist/wrangler.js:36`, `config.main ?? "@astrojs/cloudflare/entrypoints/server"`)
and its docs show importing `handle` from `@astrojs/cloudflare/handler` and exporting a Worker object with extra
handlers. `scheduledHandler(runtime, { requireAlertSink: true })` (`reconciliation.ts:397`) builds a context and
runs `runReconciliation`. Operator bearer auth exists in `booking-actions.ts:128-135` against
`RESERVA_OPERATOR_SECRET`.

**Decision.** One Worker. The consumer's `src/worker.ts` exports `fetch: handle` and a `scheduled` that calls
`scheduledHandler` directly, sharing bindings and secrets. The ops route exists for manual and dashboard triggers;
both paths share the D1 lease. No second Worker, no service binding.

**Changes.**
- New route `reconcile` — `POST /api/booking/ops/reconcile`, group `ops`. Auth: operator bearer (same helper as the
  operator routes) **or** admin identity (so the dashboard can trigger it later). Body optional
  `Partial<ReconciliationOptions>` (limits only; `requireAlertSink` not settable). Runs `runReconciliation` and
  returns `ReconciliationSummary` as JSON (`200`). Missing alert sink → `503`, code `internal_error`, message
  `operational alert sink not configured`. Concurrency: D1 lease row (`reconciliation_lease`, 4-minute TTL,
  compare-and-set); an overlapping trigger gets `409` with new code `reconciliation_in_progress`.
- `scheduledHandler` stays first-class (not deprecated) and is exported as the supported custom-entry helper; it
  already returns a `(controller, env, ctx)` handler (`reconciliation.ts:397-400`). Both entry paths take the
  lease: an overlapping route call gets the `409`; an overlapping scheduled invocation logs a warning and exits
  successfully because another invocation is doing the work. Both successful paths update `lastRunAt`/`lastSummary`.
- Packaged template `examples/smoke-site/worker/` is deleted. Replacement is `src/worker.ts` in the site:
  ```ts
  // src/worker.ts
  import { handle } from '@astrojs/cloudflare/handler';
  import { scheduledHandler } from '@reservajs/astro/runtime';
  import runtime from './runtime';

  export default {
    fetch: handle,
    scheduled: scheduledHandler(runtime),
  } satisfies ExportedHandler<Env>;
  ```
  `wrangler.jsonc` gains `"main": "./src/worker.ts"` and `"triggers": { "crons": ["*/5 * * * *"] }` (the cadence
  the deleted worker config used); secrets and bindings are the site's own.
- Docs: deployment.md step 8 rewritten around the custom `main`; delete the second-Worker and duplicated-secrets
  instructions and the `wrangler deploy --config` path.
- Ops health gains `reconciliation: { lastRunAt, lastSummary }` from the lease row; new incident type
  `reconciliation_stale` opened on health read when `lastRunAt` is older than 3× the documented cadence.
- mazetours: delete `worker/` and its wrangler config and secrets; add `src/worker.ts` and `main` + `triggers.crons`
  to the site's `wrangler.jsonc`; drop the Vite-free shim.

**Tests.** Workers-pool test: POST with bearer → summary JSON; without → 403; concurrent route call → 409;
concurrent scheduled invocation → successful no-op with a warning. Health reports `lastRunAt`. Pack fixture builds the site with the custom `main`
and asserts the bundle exports `fetch` and `scheduled`; `verify:packaged` "scheduled" step runs it with
`wrangler dev --test-scheduled`.

## 14. Email alert sink shipped and wired by default

**Current state.** `OperationalAlertSink.send(alert)` (`events.ts:179`) has no shipped implementation;
`scheduledHandler` defaults `requireAlertSink: true` (`reconciliation.ts:343,399`) so consumers pass `false`.
`EmailProvider.send(event, booking, …)` (`events.ts:84`) is booking-specific; no plain-message method.

**Decision.** Alerts go by email to the business contact. If email is down, the incident still shows on the
dashboard; no second channel.

**Changes.**
- `EmailProvider.sendMessage?(message: { to: string; subject: string; html: string; text: string }): Promise<void>`.
  Brevo implements it with the same transport/`ProviderFailure` mapping as `send`. `email-none` implements it as
  a logged no-op.
- `emailAlertSink(email: EmailProvider, options?: { to?: string })` exported from `@reservajs/astro/runtime`.
  Throws at construction if the provider lacks `sendMessage`. Renders with the existing email branding
  (`renderDefaultEmail` shell) using new copy keys `alert.subject` ("[Reserva] Attention required: <action> for
  <reference>"), `alert.body` (action, severity, attempt count, first detected, admin link). Locale:
  `config.emails.locale ?? locales.default`.
- Runtime: when `providers.alerts` is absent and `providers.email?.sendMessage` exists, wire
  `emailAlertSink(providers.email, { to: business.contact.email })` and `logger.info` once. Explicit `alerts`
  still wins. `requireAlertSink` semantics unchanged; the reconcile route (item 13) reports 503 only when neither
  exists.
- Docs: deployment.md alert paragraph; AGENTS.md ports table.
- mazetours: remove `requireAlertSink: false`.

**Tests.** Sink renders both languages; runtime auto-wires when email provider has `sendMessage`; Brevo
`sendMessage` maps 4xx/5xx to `ProviderFailure`.

## 15. `@reservajs/astro/dev` — in-memory providers for `astro dev`

**Current state.** `examples/smoke-site/src/runtime.ts:40-140` implements fake payments/calendar/email/alerts;
mazetours copies the payment fake (`src/booking/simulated-payments.ts`). Not exported.

**Decision.** Move the fakes into the package as a `./dev` subpath. Small item (~1 h).

**Changes.**
- `src/dev/index.ts` exporting `devProviders(options?: { customer?: { name; email; phone }; pickupAddress?: string })`
  returning `ReservaProviders`: payments (checkout → confirmation path with `sessionId`, session state in a
  module-scope `Map`, `getSession` reports paid, `refund`/`cancelPayment` no-ops), calendar (module-scope `Map`),
  email (`console.info` with customer/operator manage URLs; implements `sendMessage`), alerts (`console.warn`).
  Also exports `devOutbox` (`{ emails, alerts }`) for smoke/e2e assertions and `armNextCalendarFailure()`.
- package.json `exports['./dev']`; build script includes it. Docs say to gate on `import.meta.env.DEV` so it is
  tree-shaken from production builds.
- Smoke site runtime imports it (pickup address via option). mazetours deletes `simulated-payments.ts`.
- Docs: "Local development" section in `development.md`: the dev-vars file with `RESERVA_TOKEN_ENC_KEY`,
  `RESERVA_OPERATOR_SECRET`, `RESERVA_CSRF_SECRET`; `bunx reserva-migrate --local`; the `devProviders()` snippet;
  the admin bypass from item 11.

**Tests.** Existing smoke/e2e suites run unchanged against the moved module. Pack fixture imports `./dev`.

## 16. Provider option clean-up (Stripe, Google Calendar, Access)

**Current state.** Aliases: `packages/stripe/src/provider.ts:38-56` (`secretKey|apiKey`, `client|stripe|stripeClient`,
`successUrl|getSuccessUrl`, `cancelUrl|getCancelUrl`, five names for the line-item label);
`calendar-google/auth.ts:14-33` (three names each for SA email/key/impersonation, `fetch|fetchImpl`, `clock|now`);
`calendar.ts:12-21` (`apiBase|apiBaseUrl|calendarApiUrl`), four exports for one class (`calendar.ts:169-173`);
`access.ts:17-24` (`clock|now`, `jwksTtlMs|cacheTtlMs`). Default `cancel_url` is `${business.url}/services/<slug>`
(`provider.ts:225-227`). `refundIdOf` (`provider.ts:154-159`) reads `charge.refunds.data`, absent since Stripe API
2022-11-15 (verified: Stripe docs say "listen to `refund.created` for information about the refund"); the handler
already tolerates `refundRef` null. `PaymentProvider` doc (`events.ts:119-134`) omits the metadata/idempotency rules.

**Decision.** One name per option, one export per class, `business.url` as the back link, delete dead refund-id
code, document the adapter contract. No API-version pinning in code (webhook shape follows the endpoint's version).

**Changes.**
- Stripe `StripeOptions`: `secretKey`, `webhookSecret`, `client?`, `now?`, `successUrl?`, `cancelUrl?`
  (string or `(booking, config) => string`), `lineItemName?`, `productDescription?`, `pickupFieldLabel?`,
  `termsOfService?`. Everything else removed. `lineItemName` defaults to the localized `serviceTitle` (item 3).
- Default `cancelUrl` = `config.business.url`.
- Remove `refundIdOf`; `charge.refunded` keeps driving cancel-on-full-refund with `refundRef: null`.
  Docs: subscribe to `checkout.session.completed`, `checkout.session.expired`,
  `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `charge.refunded`,
  `charge.dispute.created`; set the webhook endpoint's API version explicitly in the Stripe dashboard.
- Google: `GoogleAuthOptions` = `serviceAccountEmail`, `serviceAccountPrivateKey`, `impersonateEmail?`, `fetch?`,
  `crypto?`, `now?`, `tokenUrl?`, `scope?`; `GoogleCalendarProviderOptions` adds `calendarId`, `auth?`, `apiBase?`,
  `timezone?`. Exports: `GoogleCalendarProvider` (named) only; `default`, `GoogleCalendar`,
  `CalendarGoogleProvider`, `createGoogleCalendarProvider`, `mapGoogleCalendarEvent` removed.
- Access: `now?`, `jwksTtlMs?`; `clock`/`cacheTtlMs` removed.
- `PaymentProvider` doc comment states: `createCheckout` must put `bookingId` in session `metadata` and
  `payment_intent_data.metadata`; `refund` must be idempotent per `paymentRef`; `parseWebhook` must throw on bad
  signature. New `docs/providers.md` "Writing a payment adapter" (port, contract test location
  `tests/payment-port.test.ts`, the dev provider as the minimal example).
- Changeset: breaking for all three; migration table old→new in MIGRATING doc.
- mazetours: `getServiceName` → removed (title from config), `paymentMethods` removed (item 2).

**Tests.** Type-level: old option names fail to compile (tsd-style test in pack fixture). Stripe params snapshot
has `cancel_url === business.url`.

## 17. Pricing: keep breakpoint rows, export the table helpers

**Current state.** `pricing.ts` has `priceFor`, `resolvedPriceTableFor`, `pricingCombinations`; only `priceFor` is
public (`core/index.ts`). `priceFor` relies on validation having sorted rows (`pricing.ts:22-24`); the resolved
config is sorted, a raw config module is not. Consumers generate rows in code for surcharges/multi-vehicle
(`mazetours/reserva.config.ts:55-70`).

**Decision.** No DSL change (no per-person unit, no surcharge field). Export the helpers; make `priceFor` order-safe.

**Changes.**
- `priceFor` picks the smallest `maxQuantity ≥ quantity` among matching rows regardless of array order.
- Export `resolvedPriceTableFor` and `pricingCombinations` from `@reservajs/astro/core`; document them in api.md
  ("build a price table for the funnel from the catalog rules or the config").
- `CatalogService.pricing` stays the raw rules (already sorted); `fromPriceMinor` unchanged.
- mazetours: replace the build-time `priceFor` loop in `BookingFunnel.astro:22-38` with `resolvedPriceTableFor`.

**Tests.** Unsorted rows → same result as sorted. Table helper snapshot for a two-pickup service.

## 18. Capacity stays a single shared pool (decided: no change)

One `capacity.default` plus admin day overrides and dated defaults (`config.ts:189`, `occupancy.ts:204-237`,
`day_overrides`/`capacity_defaults` tables). Per-service capacity is out of scope. README "What it books" gets one
sentence: all services draw from one capacity pool; independent fleets are not modelled.

## 19. Schedule rule: `lastEnd` as an alternative to `lastStart`

**Current state.** `scheduleSchema` (`config.ts:29-38`) takes `firstStart`, `lastStart` (default 18:00),
`intervalMin`. Consumers subtract duration by hand (`mazetours/reserva.config.ts:36-42`). Closing whole days is
already covered by admin day overrides (capacity 0 + reason). Explicit start lists: not wanted.

**Decision.** Add `lastEnd`; exactly one of `lastStart` / `lastEnd` per rule.

**Changes.**
- `scheduleSchema`: `lastStart` loses its default; `lastEnd?: HH:MM`. Refinement: both set → error
  `services.<slug>.schedule.<i>: declare lastStart or lastEnd, not both`; neither → `lastStart` defaults to 18:00
  (preserves today's behaviour). `lastEnd < firstStart + durationMin` → error naming the rule.
- Resolution: `ResolvedScheduleRule` always carries a computed `lastStart` (`lastEnd − durationMin`, floored to the
  interval grid from `firstStart`) so `slots.ts` and `occupancy.ts` are unchanged. Resolved config keeps `lastEnd`
  for display.
- Settings page: rules declared with `lastEnd` show "Last departure" read-only with the derived value and a hint
  "derived from closing time 19:00 in config"; `firstStart`, `intervalMin`, `days` stay editable.
- AGENTS.md config table, configuration.md, tour-operator example switch to `lastEnd`.
- mazetours: delete `hhmm()` and the subtraction; write `lastEnd: '19:00'`.

**Tests.** 8-hour tour with `lastEnd 19:00` → last slot 11:00; both fields → validation error; `lastEnd` too early
→ error. Admin Hours save that pushes a derived last departure past `lastEnd` is rejected with the same message.

## 20. `settings.changed` webhook so a static site can rebuild from admin edits

**Context.** The admin is the source of truth for prices, hours, capacity and policy (decided over a git-based
alternative). mazetours' marketing pages are static and bake prices at build. Chosen approach: the build reads the
live catalog; an admin save triggers a rebuild.

**Current state.** `BOOKING_EVENTS` (`events.ts:8-15`) is booking-only; `config.webhooks[].events` validates against
it. The durable outbox (`side_effect_operations`) requires a `booking_id` (`0001_init.sql:85,104`), so a settings
event cannot use it without a migration. Admin saves are logged in `admin_changes` (`repo.ts:46-51,1077`).
Catalog (`handlers/catalog.ts`) already serves prices with admin overrides applied.

**Decision.** New event `settings.changed`, delivered non-durably (no outbox row), fired once per admin save.

**Changes.**
- `SETTINGS_EVENTS = ['settings.changed']`; `WEBHOOK_EVENTS = [...BOOKING_EVENTS, ...SETTINGS_EVENTS]` is what
  `config.webhooks[].events` and hook filters validate against. `BOOKING_EVENTS` unchanged for booking payloads.
- Envelope: `{ apiVersion: 1, id: 'settings/<changeBatchId>', event: 'settings.changed', occurredAt,
  data: { changes: [{ domain, key, action, actor }] } }` — the rows the save wrote to `admin_changes`.
- Fired from the admin POST handler after `settings-save`, `settings-reset`, day-override and capacity-default
  writes, via `waitUntil`: sign and POST with `deliverWebhook`, up to 3 attempts with 2 s/8 s backoff inside the
  request lifetime; final failure → `logger.error('settings webhook delivery failed', { name, status })`. No
  incident row (a missed rebuild is recovered by saving again or deploying manually; documented).
- In-process hooks may also subscribe to `settings.changed`; handler receives `(event, null, { id, occurredAt,
  config, changes })` — `booking` is `null` for this event (type narrowed by event name).
- Docs: api.md event list; deployment.md "Rebuilding a static site on admin changes" with two receivers:
  a Cloudflare Workers Builds deploy hook URL (verified 2026-09: plain POST, no auth header, body and signature
  ignored, 10 builds/min per Worker) and a verifying Worker that forwards to GitHub `repository_dispatch`. A hook
  fired while a build is still `queued`/`initializing` is deduplicated, not queued; that is safe because such a
  build has not yet fetched the catalog. A save during a running build queues a new build. So consecutive saves
  do not guarantee consecutive builds, but the last build to run always reads the latest catalog.
- mazetours: `webhooks: [{ name: 'rebuild', url: <deploy hook>, secretBinding: 'REBUILD_WEBHOOK_SECRET',
  events: ['settings.changed'] }]`; build step fetches `/api/booking/catalog` for prices; the hand-typed
  `tour-durations.ts` prices go away.

**Tests.** Settings save → one signed POST with the change list; receiver 500 → three attempts then error log;
`events: ['settings.changed']` validates; booking-only subscribers do not receive it.

## 21. `meta` passthrough on services and meeting points

**Current state.** `CatalogService` (`api.ts:247-257`) exposes slug/title/duration/location/pricing only. Sites keep
parallel files keyed by slug (`mazetours/src/data/tour-durations.ts`, `meeting-points.ts` with coords).

**Decision.** Opaque JSON `meta` on `ServiceConfig` and `MeetingPoint`, returned by the catalog, never read by the
library. With item 20 the build fetches the catalog, so content and prices come from one call.

**Changes.**
- `config.ts`: `meta: z.record(z.string(), z.unknown()).optional()` on `serviceSchema` and `meetingPointSchema`;
  refinement: must be JSON-serializable (`JSON.stringify` round-trip) and ≤ 8 KB per entry, error
  `services.<slug>.meta: must be JSON-serializable and under 8 KB`.
- Catalog: `CatalogService.meta: Record<string, unknown>` and `CatalogMeetingPoint.meta` (always present, `{}`
  when absent, per the always-present convention).
- Settings page/admin: not editable, not shown.
- Docs: configuration.md "Site content next to the service"; AGENTS.md table row.
- mazetours: move `image`, tagline keys, `coords` into `meta`; delete the two parallel files.

**Tests.** Meta round-trips through the catalog; non-serializable value (function, BigInt) fails validation.

## 22. Admin dashboard: small usability fixes (no day view)

**Current state.** Rows show email/phone as text (`admin-page.ts:238-239`); search haystack excludes phone and
metadata (`:62`); status filter lacks `expired` (`:355`); retry always redirects with `saved=incident-retried`
(`handlers/admin.ts:180-181`) though `reprojectIncidentAfterAdminRetry` knows the result; `formatDayDate` omits the
year (`format.ts:24-35`); hold rows show only a tinted word (`admin-page.ts:224-226`); no `@media print` in
`theme.ts`. Day-view list: decided not needed.

**Decision.** Ship the seven fixes below; keep the upcoming-list layout.

**Changes.**
1. Contact cell: `<a href="mailto:">`, `<a href="tel:">` (digits only), and `wa.me/<digits>` when the stored phone is
   E.164-parsable; same helper reused by the manage page and item 4's contact block.
2. Search haystack adds `customerPhone` (digits-normalized) and every `metadata` value.
3. Status filter options: all, confirmed, hold, expired, cancelled, no_show.
4. `reprojectIncidentAfterAdminRetry` returns `'resolved' | 'still_open' | 'not_retryable'`; redirect carries
   `saved=incident-resolved | incident-retry-failed | incident-retry-unavailable` and the page renders the matching
   existing message key (`admin.incidentRetryFailed`, `admin.incidentRetryNotAvailable`, new
   `admin.incidentResolved`). `admin.incidentRetried` removed.
5. `formatDayDate(dateKey, locale, now?)` adds `year: 'numeric'` when the year differs from `now` (shared with item 9).
6. Hold rows render `<span class="bk-badge bk-badge--warn">` with `status.hold` and the hold expiry time.
7. `theme.ts` gains `@media print`: hide nav, tabs, sidebar, forms, theme toggle; open all `<details>`; rows
   full-width; day title as page header.

**Tests.** Component tests for search on phone/metadata, filter `expired`, retry outcome messages, hold badge, and
a snapshot of the print CSS block.

## 23. Customer pages and emails: small fixes

**Current state.** Manage/confirmation never render `end` (`status-manage.ts:33,67`); calendar buttons only on the
confirmation page (`confirmation-page.ts:58-61`); manage error map covers three codes (`manage-page.ts:117-121`);
`formatDateTime` uses bare `en` (US order) while email upgrades to `en-GB` (`render.ts:39`); manage-enhancer defaults
locale to `'pt-PT'` (`manage-enhancer.ts:44`); confirmation email card lacks price/reference/deadline
(`render.ts:161-169`); `RenderedEmail` has no attachments (`render.ts:28`); WhatsApp is plain text
(`render.ts:184,208`); no owner email on `payment.dispute_created` (`email-brevo/index.ts:36`).

**Decision.** Ship all nine.

**Changes.**
1. Manage and confirmation facts: "Date" row shows `start – end` times; ICS/Google events already use `end`.
2. Manage page (status confirmed): same Google/ICS buttons as confirmation, built from `serviceTitle` (item 3).
3. Manage error map: `refund_failed` → `manage.cancelledRefundPending` ("Booking cancelled; the refund could not be
   issued automatically and will be handled by us"); `refund_conflict` → `manage.errorConflict`; `forbidden` →
   `manage.errorInvalidLink`; `too_many_holds`, `calendar_unavailable`, `internal_error` → `manage.actionFailed`
   with "try again in a minute".
4. Past-cutoff notice and invalid-token page render the contact block (item 4). Invalid-token page drops the
   "paste your token" form; copy says to use the link from the email.
5. `formatLocaleFor` moves to `src/core/locale.ts`, used by `ui/format.ts` too; manage-enhancer reads
   `data-locale` and falls back to `document.documentElement.lang`.
6. Confirmation/rescheduled email card adds rows: service title, price (`formatPrice`), reference, cancellation
   deadline ("free cancellation until <date time>"); `footerHtml` keeps the reference.
7. `RenderedEmail.attachments?: Array<{ filename: string; contentType: string; content: string /* base64 */ }>`.
   `renderDefaultEmail` attaches `booking.ics` for `booking.confirmed` and `booking.rescheduled` (customer copy).
   Brevo maps to its `attachment: [{ name, content }]`; `email-none` ignores.
8. Email contact block: WhatsApp rendered as `<a href="https://wa.me/<digits>">`.
9. `payment.dispute_created` → owner email only: subject "Payment dispute opened for <reference>", body with
   amount, reference, admin link; copy keys `dispute.owner.*`. `EmailBookingEvent` gains the event;
   `recipientsForEvent` returns `['owner']` for it.
- New copy keys in `email/copy.ts` (en, pt-PT) and `ui/messages.ts` + `pt-PT.json`.

**Tests.** Render snapshots per event/locale; Brevo request body includes the attachment; manage page error copy
per code; enhancer locale fallback.

## 24. Reminder email before the start

**Current state.** No reminder anywhere (`grep -ri remind src` → only a removed-column probe). Reconciliation sweep
runs on the cron (item 13); durable side effects live in `side_effect_operations` keyed by
`(booking_id, family, name, event, discriminator)`.

**Decision.** One reminder email per confirmed booking, default 24 h before start, configurable per deployment.

**Changes.**
- `config.booking.reminderHoursBefore?: number` — integer ≥ 1, default 24; `0` disables. Editable on the admin
  settings "policy" section.
- `BOOKING_EVENTS` gains `'booking.reminder'` (webhooks/hooks may subscribe; email is the built-in subscriber).
- Sweep step in `runReconciliation` (bounded like the others): select confirmed bookings with
  `starts_at` in `(now, now + reminderHours]` lacking a `side_effect_operations` row
  `(family='email', event='booking.reminder', discriminator=starts_at)`; insert one row per such booking and
  dispatch through the normal outbox path (retries, abandonment, incident). Discriminator = `starts_at` so a
  reschedule to a new time re-arms and the old row is left as history. Bookings created inside the window get no
  reminder (they just received the confirmation); enforced by `created_at < starts_at − reminderHours`.
- Email: `EmailBookingEvent` gains `booking.reminder`; customer only; copy keys `reminder.customer.*` ("See you
  tomorrow" style, card with date/time, meeting point/pickup, manage button, ICS attachment).
- Docs: AGENTS.md config table, api.md events list, README events block (generated).

**Tests.** Sweep at T−24h creates one row; second sweep creates none; reschedule creates a new row with the new
discriminator; booking made at T−2h gets none; `reminderHoursBefore: 0` disables.

## 25. Favicon and head HTML for library pages

**Current state.** `pageShell` (`layout.ts:32-35`) emits a fixed `<head>` plus `headExtra` used only for the
meta-refresh; `config.ui` has only `messages` (`config.ts:222-225`). No favicon; no way to add fonts or a stylesheet.

**Decision.** Two config keys; no layout slots.

**Changes.**
- `config.ui.faviconUrl?: string` (URL or path) → `<link rel="icon" href="…">` on every server-rendered page.
- `config.ui.headHtml?: string` → appended verbatim after the library's own `<link rel="stylesheet">` so consumer
  CSS can override tokens. Documented as trusted markup and the consumer's CSP responsibility.
- `pageShell` gains `favicon?` and `headHtml?`; all four page renderers pass them from `context.config.ui`.
- Docs: customization.md "Head and favicon".

**Tests.** Rendered page contains the favicon link and the head HTML once, after the stylesheet link.

## 26. Security posture visible in ops health and the dashboard

**Current state.** `verifyAdminCsrfToken` returns `true` with no secret (`admin-csrf.ts:100-101`), unlogged;
`cloudflareAccessAdminAuth` yields `subject: ''` without email/sub (`access.ts:124`); `secrets(name)` returns
`undefined` for names outside the allowlist (`runtime-context.ts:235-239`); `OpsHealthResponse` = schema/outbox/
incidents (`api.ts:296-300`); `RESERVA_TOKEN_ENC_KEY` one-way door is prose in deployment.md.

**Decision.** Report, don't change defaults; reject empty Access subjects; warn on unknown secret names.

**Changes.**
- `OpsHealthResponse.security: { csrfTokenLayer: 'on' | 'off'; tokenEncryption: 'on' | 'off';
  adminAuth: 'access' | 'custom' | 'dev-bypass' }`. Computed from secret presence and the resolved auth path.
- Admin dashboard "Attention" area renders a warning card when `csrfTokenLayer` or `tokenEncryption` is `off`,
  with the secret name to set (`admin.securityCsrfOff`, `admin.securityTokenEncOff` copy keys).
- `cloudflareAccessAdminAuth`: no `email` and no `sub` → return `null` (403) and `logger.warn`.
- `secrets(name)` outside the allowlist → `logger.warn('secret not in secretBindings', { name })` once per isolate
  per name; still returns `undefined`.
- deployment.md setup list: numbered steps "set `RESERVA_TOKEN_ENC_KEY` before the first booking (cannot be
  rotated without invalidating manage links)" and "set `RESERVA_CSRF_SECRET`" placed before the first deploy.

**Tests.** Health reflects each flag; JWT without email/sub → 403; unknown secret name logs once.

## 27. Database hot spots

**Current state.** `listUpcoming`/`listAllFrom` unbounded + `hydrateBooking` AES-GCM per row (`repo.ts:1769-1783`,
`handlers/admin.ts:56-71`); `sweepExpiredHolds` UPDATE on availability/checkout/admin GET (`availability.ts:250`,
`checkout.ts:225`, `admin.ts:54`; `repo.ts:1087`); `listOccupancyBookings` selects all `bookingColumns`
(`repo.ts:1760`); reference collision handled by read-then-retry (`repo.ts:1126` area); reconciliation
`sourceLimit` 50 per run (`reconciliation.ts:35-36`).

**Decision.** Five contained changes, no schema migration.

**Changes.**
1. Admin list: `listUpcoming(now, { untilDays: 90, limit: 500 })`; page shows "Show later bookings" link
   (`?until=180`) and the filter path `listAllFrom` gets the same limit. Token hydration moves to the renderer for
   the rows it emits.
2. `sweepExpiredHolds` wrapped in `throttled(60_000)` per isolate (module-level timestamp); cron sweep remains the
   guarantee. Checkout keeps an unthrottled sweep only when the hold insert reports a capacity conflict (so a
   just-expired hold frees the slot immediately).
3. `listOccupancyBookings` selects `id, service_slug, quantity, occupancy_units, starts_at, occupancy_ends_at,
   status` only; `OccupancyBooking` type narrowed accordingly.
4. `createBooking`: `INSERT … ON CONFLICT(reference) DO NOTHING`; on zero changes regenerate the reference and retry
   (max 5). Drop the pre-read.
5. `runReconciliation`: loop batches of `sourceLimit` until a batch returns fewer than the limit or 20 s wall
   clock elapse; summary reports batches run.

**Tests.** Admin list caps at limit and renders the "later" link; sweep throttle (fake clock) skips within 60 s;
occupancy query column list snapshot; reference conflict path; reconciliation loops on a 120-row backlog.

## 28. Generated schema fingerprint; migrate CLI hardening

**Current state.** `RESERVA_MIGRATIONS` is a hand list (`src/migrations-manifest.ts`) guarded by a test; the
fingerprint is hand-written probes (`schema-check.ts:52-160`: `REQUIRED_BOOKINGS_COLUMNS`, `REMOVED_BOOKINGS_COLUMNS`,
per-table checks). `scripts/reserva-migrate.ts` writes a derived wrangler config beside the consumer's
(`:146-148`, `:342-348`) and shells to `wrangler` on PATH (`:354`).

**Decision.** Build-time generation from `migrations/*.sql`; CLI cleanup and preflight.

**Changes.**
- `scripts/build.ts` parses `migrations/*.sql` (CREATE TABLE columns, CREATE INDEX names, CHECK constraint text,
  ALTER TABLE ADD/DROP COLUMN applied in order) into `src/generated/schema-fingerprint.ts`:
  `{ migrations: string[], tables: Record<string, { columns: string[]; indexes: string[] }> }`. Generated file is
  gitignored and produced by `bun run build`; `RESERVA_MIGRATIONS` is imported from it (manifest file removed).
- `schema-check.ts`: ledger check unchanged; fingerprint check compares `PRAGMA table_info` / `sqlite_master`
  index names per table against the generated set. `REMOVED_BOOKINGS_COLUMNS` probe kept only as the explicit
  "pre-v2 database" detector.
- Migrations added by items 13 (`reconciliation_lease`) and 24 (none: reminders reuse `side_effect_operations`)
  follow the pattern `NNNN_<name>.sql`; MIGRATING doc gets a "how to add a migration" section.
- `reserva-migrate`: temp config written under `os.tmpdir()` (not beside the consumer's file) and removed in a
  `finally` plus `SIGINT` handler; preflight `wrangler --version` with a clear "install wrangler" error.

**Tests.** Fingerprint generator snapshot for the current migrations; a fixture migration adding a column changes
the fingerprint; CLI test for missing wrangler and for temp-file cleanup on failure.

## 29. Small cleanups

**Current state.** README/AGENTS/examples import `Env` from `worker-configuration` but `wrangler types` (verified
locally, wrangler 4.132) emits a global `interface Env` with no export. Dead message keys: `common.back`,
`admin.backToAdmin`, `common.brandFallback`, `common.time`; `widget.*` keys serve only the example widget.
`components.css:5-45` duplicates the `--bk-*` token block; no token table in docs. `ManageBooking.astro:18` resolves
messages without `config`. Email time forced `hourCycle: 'h23'` (`render.ts:81`) while pages follow the locale.

**Decision.** All five.

**Changes.**
1. Docs and examples use the global `Env` (`defineCloudflareReservaRuntime<Env>` with no import). `test:quickstart`
   runs `wrangler types` and type-checks the runtime file against its output.
2. Remove the four dead keys; move `widget.*` keys into `examples/smoke-site` as its own catalog; `ReservaMessageKey`
   shrinks accordingly.
3. `src/ui/tokens.css` is the single token block; `theme.ts` and `components.css` include it at build. `customization.md`
   gains a generated table of every `--bk-*` token with its light/dark default (generated by `docs:contract`).
4. `ManageBooking.astro` reads `config.ui.messages` through `virtual:reserva/config` (item 12) before applying the
   `messages` prop.
5. `render.ts` time formatting drops `hourCycle`; both surfaces use the locale default.

**Out of scope (decided).** Operator-created bookings without payment.

**Tests.** Quickstart type-check; message key snapshot; token table generation check in `docs:contract:check`.

## Phases

Ordered so each phase leaves `main` releasable. Items in one phase are independent unless noted.

**Phase A — correctness (patch release first).**
1 schedule union · 2 Stripe dynamic methods + delayed-method refusal · 4 confirmation timeout/`failed` · 6 messages +
`details` · 26 security posture (Access empty-subject 403) · 27.2 sweep throttle.

**Phase B — contract and config (the breaking release core).**
7 field names · 3 localized required titles · 5 pickup labels · 10 response gaps · 12 single config source +
`occupancy.seatsPerUnit` + default entrypoint + env schema · 19 `lastEnd` · 21 `meta` · 16 provider option
clean-up · 17 pricing helpers/order-safe `priceFor` · 29.1 global `Env` docs.
Order inside B: 12 before 8/11/29.4 (virtual config shape); 3 before 16 (line-item default) and 23 (titles on pages).

**Phase C — consumer surface.**
8 typed client · 9 format exports + slot `date`/`time` + calendar helpers · 15 `./dev` providers · 25 favicon/head ·
29.2–29.5 cleanups. Update `examples/smoke-site` and the mazetours funnel to the client here.

**Phase D — operations.**
13 reconcile route + `scheduled` in the site Worker · 14 email alert sink · 20 `settings.changed` webhook · 24 reminders ·
27.1/27.3/27.4/27.5 DB hot spots · 28 generated fingerprint (do 28 before 13/24 add tables).

**Phase E — UX polish.**
22 admin fixes · 23 customer pages and emails.

**Verification per phase.** `bun run verify` (typecheck, docs contract, unit, component, workers) and
`bun run verify:packaged` (preview, scheduled, pack, quickstart). Phase D additionally runs the e2e suite against the
site Worker's `scheduled` export.

**mazetours upgrade checklist (after 0.5.0).** Drop `paymentMethods`, `getServiceName`, `tourName()`; add
`title`, `lastEnd`, `occupancy.seatsPerUnit`, `meta`; replace `simulated-payments.ts` with `devProviders()`; replace
`worker/` with `src/worker.ts` + `main` in `wrangler.jsonc` and delete duplicated secrets; remove `requireAlertSink: false`; funnel on
`@reservajs/astro/client` with `resolvedPriceTableFor`; add the `rebuild` webhook and a build step that fetches the
catalog; delete `tour-durations.ts` prices and `meeting-points.ts` coords; at domain cutover add `admin.access` and
delete the demo auth files.

## Resolved decisions

| # | Decision |
|---|---|
| 1 | Same-day schedule rules union; identical starts across rules are a validation error |
| 2 | No `payment_method_types`; curated `excluded_payment_method_types`; unpaid completion refused, cancel best-effort; late async payment auto-refunded; `submit_type: 'book'` |
| 3 | `title`, meeting-point and pickup labels are `LocalizedText`; `title` required; `serviceTitle` on wire shapes |
| 4 | Confirmation polls ≤ 60 s then "still processing"; new `failed` status opens an incident; shared contact block |
| 5 | No `default`/`custom` magic ids; pickup `label` required; address rows key off `requiresAddress` |
| 6 | Five messages rewritten to name the field; `error.details { field, allowed }`; cancel race → `invalid_transition` |
| 7 | `serviceSlug`, `pickup`, `start`, `sessionId`; old names accepted one minor with a warning |
| 8 | `@reservajs/astro/client` typed client with `ReservaApiError` |
| 9 | Export `format.ts`; slots carry `date`/`time`; `quantity` optional; calendar helpers in `./client` |
| 10 | `paymentDeadline`, `cancelDeadline`/`rescheduleDeadline`, post-grace status summary; drop `QuoteRequest.locale` |
| 11 | Access only; `dev: true` from `astro dev` bypasses the admin gate; no password auth |
| 12 | Config through `virtual:reserva/config`; `occupancy.seatsPerUnit`; default entrypoint; `RESERVA_*` env only |
| 13 | `POST /api/booking/ops/reconcile` + `scheduled` in the site Worker via custom `main`; lease row; stale-cron incident |
| 14 | `EmailProvider.sendMessage`; `emailAlertSink` auto-wired to the business contact |
| 15 | `@reservajs/astro/dev` `devProviders()` |
| 16 | One name per provider option; `cancelUrl` = `business.url`; dead refund-id code removed; adapter contract doc |
| 17 | Pricing DSL unchanged; export table helpers; order-safe `priceFor` |
| 18 | Single capacity pool (no change) |
| 19 | `lastEnd` alternative to `lastStart`; enforced on admin Hours edits too; no explicit start lists |
| 20 | `settings.changed` webhook, non-durable, fired per admin save |
| 21 | `meta` JSON passthrough on services and meeting points, surfaced by the catalog |
| 22 | Seven admin fixes; no day view |
| 23 | Nine customer page/email fixes incl. `.ics` attachment and dispute owner email |
| 24 | Reminder email, `booking.reminderHoursBefore` default 24, via the reconciliation sweep |
| 25 | `ui.faviconUrl`, `ui.headHtml` |
| 26 | `security` block on ops health + dashboard warning; empty Access subject → 403; unknown secret warns |
| 27 | Admin list bounded; sweep throttled; narrow occupancy query; `ON CONFLICT` reference; reconciliation loops |
| 28 | Schema fingerprint generated from `migrations/*.sql`; migrate CLI temp-file cleanup and wrangler preflight |
| 29 | Global `Env` docs; dead keys removed; single token block + docs table; `ManageBooking` honours config messages; locale-default time format |
