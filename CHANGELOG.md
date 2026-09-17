# Changelog

## 0.5.0

### Minor Changes

- 893229a: `astro dev` bypasses the admin gate automatically. When `config.admin.access` is set and the build
  came from `astro dev`, the admin and operator routes resolve `{ subject: 'dev' }` without calling
  Cloudflare Access — which cannot protect `localhost` — and log `admin auth bypassed: astro dev`
  once per isolate. Ops health reports `security.adminAuth: 'dev-bypass'` in that state. The flag
  behind it comes from Astro's build command, never from runtime env, so `astro build` and
  `astro preview` output always calls Access, and a custom `adminAuth` is never bypassed. Consumers
  can delete the hand-written dev `adminAuth` they used to need.
- 893229a: Add `@reservajs/astro/client`: a browser-safe, typed API client. `createReservaClient({ paths | base, fetch, bearer })` covers catalog, availability, quote, checkout, status, manage, cancel, reschedule, the operator routes, `opsHealth` and `opsReconcile`, with every failure — envelope, bare non-2xx or network error — surfaced as a `ReservaApiError` carrying `status`, `code` and `details` (`isReservaApiError` narrows it). The entry imports only the wire types, `API_ERROR_CODES` and a new Astro-free route pattern table (`src/core/route-paths.ts`, now the single source `routes-manifest.ts` builds on), so it pulls no Astro, Node or Cloudflare code into a bundle.
- 893229a: Add `@reservajs/astro/dev`: `devProviders(options?)` returns in-memory payment, calendar, email and alert providers so `astro dev` runs the whole booking flow with no external account. Checkout redirects straight to the confirmation page and the session always reports paid; the email provider logs the customer and operator manage URLs and implements `sendMessage`. `devOutbox` (`{ emails, alerts }`) and `armNextCalendarFailure()` are exported for local assertions. Gate the import on `import.meta.env.DEV` so a production build tree-shakes it.
- 893229a: Operational alerts now have a shipped sink, wired by default.
  
  `EmailProvider` gains an optional `sendMessage({ to, subject, html, text })` for a plain message
  with no booking behind it. The Brevo adapter implements it over the same transport and
  `ProviderFailure` mapping as its booking sends; `email-none` implements it as a logged no-op.
  
  `emailAlertSink(email, { to? })` is exported from `@reservajs/astro/runtime`. It renders through the
  existing branded email shell using new `alert.subject`/`alert.body` copy keys (en and pt-PT,
  overridable via `config.emails.messages`) and throws at construction if the provider has no
  `sendMessage`.
  
  When `providers.alerts` is absent and `providers.email?.sendMessage` exists, the runtime wires
  `emailAlertSink(providers.email, { to: business.contact.email })` automatically and logs it once, so
  a deployment with an email provider no longer has to pass `requireAlertSink: false`. An explicit
  `providers.alerts` still wins.
- 893229a: The schema fingerprint is generated from the migrations instead of hand-maintained.
  
  `scripts/generate-schema-fingerprint.ts` replays `migrations/*.sql` (CREATE TABLE columns, CREATE
  INDEX names, ALTER TABLE ADD/DROP/RENAME COLUMN, and the rebuild-and-rename pattern) into
  `src/generated/schema-fingerprint.ts`. `bun run build` runs it first; it can also be run alone. The
  generated module is committed (`bun run generate:check` fails when it drifts from its inputs) and exports `RESERVA_MIGRATIONS` (so `src/migrations-manifest.ts` is
  gone) plus the table/column/index sets the isolate-time check now compares `PRAGMA table_info` and
  `sqlite_master` against — no more hand-written per-table probes drifting from the SQL. The pre-v2
  column probe is kept solely as the "this database predates the v2 rename" detector.
  
  `reserva-migrate` also writes its derived wrangler config under `os.tmpdir()` (removed in a
  `finally` and on `SIGINT`, and pinned back to the project with `--cwd`) instead of beside the
  consumer's config, and preflights `wrangler --version` with an actionable "install wrangler" error.
- 893229a: Service titles are required and localized, and travel on every wire shape.
  
  `services.<slug>.title` is now required and takes `LocalizedText` (a string or a
  `Record<locale, string>`), as do meeting-point labels and pickup labels/hints. `serviceTitle` is
  added to `WireBooking`, `ConfirmationBooking` and `ManageBooking`, and `CatalogService.title` is
  resolved for the request locale. Every renderer — manage page, confirmation facts, the ICS summary
  and Google Calendar link, admin rows and search, settings groups, emails — reads the resolved
  title; the `title ?? slug` fallbacks are gone. `resolveMetadataFieldLabel` is renamed
  `resolveLocalizedText` (the old name stays as an alias for one release) and
  `resolveServiceTitle(config, slug, locale)` is exported. The Stripe line item defaults to the
  localized title.
- 893229a: One vocabulary across the endpoints: `serviceSlug`, `pickup`, `start` and `sessionId`.
  
  Availability reads `?serviceSlug=`, status reads `?sessionId=`, the checkout body reads `pickup`
  and the reschedule body reads `start`. The previous spellings (`?service=`, `?session_id=`,
  `pickupType`, `newStart`) still read for one minor and log `deprecated field` once per isolate per
  field; they are removed from the exported request types now. `ManageBooking.pickup` replaces
  `ManageBooking.pickupType`, `CheckoutRequest.pickup` replaces `CheckoutRequest.pickupType`, and
  `RescheduleRequest`/`CancelRequest` are exported for the first time. The Stripe adapter's default
  success URL emits `sessionId={CHECKOUT_SESSION_ID}`. The webhook envelope's booking keeps
  `pickupType`, which stays frozen for this release line.
- 893229a: Pickup ids are opaque; pickup labels are required.
  
  `pickupOptions[].label` is now required and localized, and `hint` is localized too. The special
  handling of the ids `default` and `custom` is gone from the catalog, admin, settings and manage
  renderers: address rows key off `requiresAddress` alone, and an option the service no longer
  declares renders its raw id with no address row. The implied `meeting_point` option — the one a
  meeting-points-only service gets for free — is named from the new message key `pickup.meetingPoint`
  ("Meeting point" / "Ponto de encontro"). `widget.pickupDefault`, `widget.pickupDefaultHint`,
  `widget.pickupCustom` and `widget.pickupCustomHint` are removed from the message catalog.
- 893229a: `priceFor` picks the tightest covering tier regardless of row order, so an unsorted pricing array (a raw config module, a hand-built rule list) prices the same as `validateConfig`'s sorted output. `resolvedPriceTableFor` and `pricingCombinations` are now exported from `@reservajs/astro/core`, with `ResolvedPriceTable`, so a funnel builds a price grid from the catalog's rules instead of reimplementing breakpoint semantics. Documented in `docs/api.md`.
- 893229a: Provider options: one name per option, one export per class.
  
  `stripe(options)` keeps `secretKey`, `webhookSecret`, `client`, `now`, `successUrl`, `cancelUrl`,
  `lineItemName`, `productDescription`, `pickupFieldLabel` and `termsOfService`; `apiKey`, `stripe`,
  `stripeClient`, `getSuccessUrl`, `getCancelUrl` and the five line-item-name spellings are gone.
  `cancelUrl` now defaults to `business.url` rather than a guessed `/services/<slug>` page, and
  `lineItemName` defaults to the service's localized title. `charge.refunded` no longer reports a
  `refundRef`: Stripe stopped expanding the charge's `refunds` list in API 2022-11-15, so the dead
  lookup is removed and the cancel-on-full-refund path keys off the amounts.
  
  `GoogleAuthOptions` and `GoogleCalendarProviderOptions` drop every alias (`googleSaEmail`,
  `saEmail`, `googleSaPrivateKey`, `privateKey`, `googleImpersonateEmail`, `subject`, `fetchImpl`,
  `clock`, `apiBaseUrl`, `calendarApiUrl`), and `@reservajs/astro/providers/calendar-google` exports
  only the named `GoogleCalendarProvider`. `verifyAccessJwt` options keep `now` and `jwksTtlMs`.
  
  `PaymentProvider`'s doc comments now state the metadata, idempotency and signature contract, and
  the new `docs/providers.md` walks through writing a payment adapter.
- 893229a: Reconciliation is triggerable on demand, and the cron ships inside the site Worker.
  
  `POST /api/booking/ops/reconcile` (group `ops`) runs the same bounded sweep the cron runs,
  authorized by the operator bearer secret **or** an admin identity. Its optional JSON body takes
  `sourceLimit`/`alertLimit`; it returns the `ReconciliationSummary`, `503 internal_error` when no
  operational alert sink is configured, and a new `409 reconciliation_in_progress` when the sweep is
  already running.
  
  Both entry points now take a deployment-wide D1 lease (new migration
  `0003_reconciliation_lease.sql`, 4-minute TTL, compare-and-set), so a manual trigger and a cron tick
  can never claim the same rows. An overlapping `scheduled` invocation logs a warning and exits
  successfully instead of failing the cron. Both successful paths record `lastRunAt`/`lastSummary`,
  which `GET /api/booking/ops/health` now reports as `reconciliation`; a deployment whose last run is
  older than three ticks of the 5-minute cadence opens a `reconciliation_stale` incident on health
  read. That is the first incident that belongs to the deployment rather than to a booking, so
  `OperationalIncidentRecord.bookingId` is now nullable.
  
  **Breaking for deployments running the separate cron Worker.** `@astrojs/cloudflare` honours a custom
  `main`, so the second Worker (and its duplicated secrets) is gone: add a `src/worker.ts` exporting
  `fetch: handle` plus `scheduled: scheduledHandler(runtime)`, and set `main` and `triggers.crons` in
  your own `wrangler.jsonc`. See the rewritten step 10 in `docs/deployment.md`. The packaged
  `examples/smoke-site/worker/` template is removed.
- 893229a: Add the reminder email. `config.booking.reminderHoursBefore` (integer ≥ 1, default 24, `0`
  disables) is editable in the admin settings "policy" section, `BOOKING_EVENTS` gains
  `booking.reminder`, and a bounded sweep in `runReconciliation` arms one reminder per confirmed
  booking whose start falls inside the window and that was created before it. The reminder rides the
  normal outbox path (retries, abandonment, incidents), discriminated by `starts_at` so a reschedule
  re-arms it. The email goes to the customer only, with new `reminder.customer.*` copy in English and
  Portuguese: a card with date, time, guests, meeting point or pickup, and the manage button.
- 893229a: Close the response contract gaps: payment and change deadlines, and a post-grace status summary.
  
  `CheckoutResponse.paymentDeadline` reports when the payment page closes (the provider's own
  `expiresAt`, falling back to the hold expiry). `ManageResponse` gains `cancelDeadline` and
  `rescheduleDeadline` as separate policies; `deadline` stays as an alias of `cancelDeadline` for one
  minor. Past the four-hour detail grace, `GET /api/booking/status` answers `confirmed` with a
  `ConfirmationSummary` (`reference`, `serviceTitle`, `start`, `end`, `locale`) instead of `null`, and
  the confirmation page renders that summary with the "details were emailed" copy. `QuoteRequest.locale`
  is removed from the type; the handler still accepts and silently ignores the key.
- 893229a: Schedule rules can declare `lastEnd` (the time the last booking must be finished by) instead of `lastStart`, so a service stops subtracting `durationMin` by hand. Exactly one of the two per rule; a rule with neither keeps the `'18:00'` default. The last departure is derived as the latest start on the interval grid that still fits the duration, and `ResolvedScheduleRule` always carries the computed `lastStart`, so slot generation and occupancy are unchanged. A `lastEnd` that leaves no room for a booking starting at `firstStart` fails validation — including on an admin Hours save that pushes the first departure past it. The admin settings page shows a derived last departure read-only, with a hint naming the closing time it comes from.
- 893229a: `meta` passthrough on services and meeting points: an opaque JSON object reserva stores, size-checks and echoes back on the catalog, but never reads. It is where a site keeps the content that belongs to a service but is not a booking rule (hero image, tagline, a meeting point's coordinates), so a static build fetches prices and content in one call instead of maintaining a parallel file keyed by slug. Values must be JSON-serializable and each object must stay under 8 KB. `CatalogService.meta` and `CatalogMeetingPoint.meta` are always present, `{}` when the config declares none.
- 893229a: Add the `settings.changed` event so a static site can rebuild from admin edits. `SETTINGS_EVENTS`
  and `WEBHOOK_EVENTS` (`BOOKING_EVENTS` + `SETTINGS_EVENTS`) are exported from
  `@reservajs/astro/core`, and `config.webhooks[].events` and hook `events` filters now validate
  against `WEBHOOK_EVENTS`. The event fires once per admin save — settings, settings reset, day
  overrides and capacity defaults — carrying the `admin_changes` rows the save wrote:
  `{ apiVersion: 1, id: 'settings/<changeBatchId>', event: 'settings.changed', occurredAt,
  data: { changes: [{ domain, key, action, actor }] } }`. Delivery is non-durable (the outbox is
  keyed by booking): signed and POSTed from the admin request via `waitUntil`, three attempts with
  2 s/8 s backoff, then `logger.error('settings webhook delivery failed', { name, status })` and no
  incident row. Subscribers receive it only by naming it explicitly, so booking-only subscribers are
  unaffected. In-process hooks get `(event, null, { id, occurredAt, config, changes })`, narrowed by
  the event name.
- 893229a: Single config source: the integration validates `reserva.config.ts` once and ships the result through `virtual:reserva/config`, which is now `{ config: ResolvedClientConfig, routes: { paths, groups, dev } }`. `defineCloudflareReservaRuntime(options)` and `defineReservaRuntime(options)` drop their config argument and read it from there, so a runtime module no longer imports (or re-validates) the config file — `reserva.config.ts` is imported only by `astro.config.ts`. `routes.dev` is `true` only in `astro dev` output.
  
  Breaking: `ServiceConfig.occupancyFor` is replaced by `occupancy: { seatsPerUnit }` (units are `ceil(quantity / seatsPerUnit)`); a function value is now a validation error naming the replacement, and the resolved config is JSON-serializable as a result. `runtimeEntrypoint` is optional and defaults to `./src/reserva-runtime.ts` resolved against the project root (a missing file still throws with the resolved path). `reservaSecretEnvSchema` keeps `RESERVA_OPERATOR_SECRET`, adds `RESERVA_CSRF_SECRET` and `RESERVA_TOKEN_ENC_KEY`, and no longer declares `STRIPE_*`, `BREVO_*` or `GOOGLE_*` — declare the provider names you want typed access to in your own `env.schema`. A consumer reading route paths moves from `routeConfig.paths.x` to `virtualConfig.routes.paths.x`. See `docs/MIGRATING-v2.md` for the 0.5.0 steps.
- 893229a: Stripe payment methods are now managed in the Stripe dashboard, and delayed payment methods are
  refused safely.
  
  **Breaking (`@reservajs/stripe`):** the `paymentMethods` option and the `StripePaymentMethod` and
  `stripePaymentMethodTypes` exports are removed, and sessions no longer send `payment_method_types`.
  Delete `paymentMethods` from your `stripe({ … })` call and enable the methods you want in the
  Stripe dashboard — Apple Pay, Google Pay and Link now appear without a code change.
  
  - Sessions send `excluded_payment_method_types` from the new exported
    `STRIPE_DELAYED_PAYMENT_METHOD_TYPES` constant (bank debits, bank transfer, vouchers), and
    `submit_type: 'book'`.
  - `createCheckout` now returns `expiresAt` alongside `url` and `sessionRef`; `PaymentProvider`
    gained the optional field and an optional best-effort `cancelPayment(paymentRef)`, implemented
    for Stripe with `paymentIntents.cancel`.
  - A completed-but-unpaid checkout session releases the hold, cancels the payment, and answers
    `200` with a warning instead of `409 payment_amount_mismatch`.
    `checkout.session.async_payment_succeeded` records and issues a full refund;
    `checkout.session.async_payment_failed` releases the hold. Subscribe your webhook endpoint to
    both new event types.
- 893229a: `@reservajs/astro/ui` now re-exports the presentation formatters (`formatDateTime`, `formatDayDate`, `formatDateParts`, `formatPrice`, `googleCalendarUrl`, `icsDataUrl`) alongside the message catalog, so an embed formats dates and prices exactly like Reserva's own pages. `formatDayDate(dateKey, locale, now?)` adds the year when the date falls in another year. Availability slots gain business-local `date` (`YYYY-MM-DD`) and `time` (`HH:MM`) next to `start`, and the `quantity` query parameter is now optional (defaults to 1). Calendar helpers `openDays`, `firstOpenDay`, `isDayDisallowed`, `dateKey` and `horizonRange` ship from `@reservajs/astro/client`.
- 893229a: Add `config.ui.faviconUrl` and `config.ui.headHtml`. The favicon becomes a `<link rel="icon">` on every server-rendered page (confirmation, manage, admin, settings); `headHtml` is emitted verbatim after Reserva's own stylesheet link, so consumer CSS and `--bk-*` overrides take precedence. It is trusted markup and the consumer's CSP responsibility.

### Patch Changes

- 893229a: Admin dashboard usability fixes.
  
  - Booking rows link the customer's contact details: `mailto:` for the email, `tel:` for the phone
    (digits only, keeping a written `+`), and a `wa.me` link when the stored number is E.164. The
    helpers (`emailLink`, `phoneLinks`, `telHref`, `whatsappDigits`) live in `src/ui/layout.ts`
    alongside `contactBlock`, which now shares them.
  - Search also matches the customer phone (compared digit by digit, so `+351 912 345 678` and
    `912345678` find the same booking) and every `metadata` value.
  - The status filter offers `expired`, so a hold nobody paid is reachable without knowing its
    reference.
  - Retrying an incident reports what happened: `reprojectIncidentAfterAdminRetry` returns
    `resolved | still_open | not_retryable` and the dashboard renders `admin.incidentResolved`,
    `admin.incidentRetryFailed` or `admin.incidentRetryNotAvailable`. The message key
    `admin.incidentRetried` is removed, and a retry on a non-retryable incident now redirects with a
    notice instead of returning 400.
  - Day headings name the year when it differs from the render clock's year.
  - A hold row carries a badge with its expiry time.
  - `@media print`: navigation, tabs, forms and the theme toggle are dropped, every disclosure prints
    open, and the list takes the full page width.
- 893229a: The confirmation page no longer polls forever, and a rejected payment says so.
  
  - `StatusState` gains `'failed'`: a completed session whose payment is not acceptable now returns
    `{ status: 'failed', booking: null }` instead of polling on as `pending`, and opens a
    `payment_verification_rejected` operational incident on the admin dashboard (new migration
    `0002_payment_verification_incidents.sql`).
  - The confirmation page refreshes at most 20 times (~60 s) via an `attempt` query parameter, then
    shows a "still waiting" page with contact details and a "Check again" link.
  - New shared contact block (email, phone, WhatsApp) on the confirmation pending-timeout, failed and
    expired pages and on the manage past-cutoff and invalid-link pages.
- 893229a: Customer pages and emails: nine fixes.
  
  - Manage and confirmation facts show the booking as `start – end`, not just the start.
  - The manage page offers the same Google/ICS calendar buttons as the confirmation page for a
    confirmed booking.
  - The manage error map covers every code an action can bounce back with: `refund_failed` now says
    the booking IS cancelled and the refund is being handled manually, `refund_conflict` and
    `forbidden` get their own copy, and the transient codes share "try again in a minute".
  - The invalid-link page drops its token entry form (the token lives in the customer's inbox, it is
    not something to retype) and renders the shared contact block, as does the past-cutoff notice.
  - `formatLocaleFor` moved to `src/core/locale.ts` and now applies to the server-rendered pages too,
    so a bare `en` reads "15 Oct" there exactly as it already did in email. The manage enhancer takes
    its calendar locale from the page instead of defaulting to `pt-PT`.
  - Confirmation and reschedule mail names the service, the price paid, the reference and the free
    cancellation deadline in the card, and attaches `booking.ics` (also on the reminder).
  - `RenderedEmail.attachments` is part of the renderer seam; the Brevo adapter maps it to
    `attachment: [{ name, content }]`.
  - WhatsApp in email is a `wa.me` link rather than a phone number in text.
  - `payment.dispute_created` now sends owner-only mail with the amount, the reference and a link to
    the admin dashboard.
- 893229a: Tighten four database hot spots. The admin list now reads `listUpcoming(now, { untilDays: 90,
  limit: 500 })` with a "Show later bookings" link (`?until=180`) and the same cap on the filtered
  `listAllFrom` path, and cancel/operator tokens are decrypted only for the rows the page actually
  emits. `listOccupancyBookings` selects the seven columns the occupancy math reads instead of every
  booking column, and returns the narrowed `OccupancyBooking` shape. Booking creation inserts with
  `ON CONFLICT(reference) DO NOTHING` and regenerates the reference on conflict (max 5 attempts),
  dropping the per-candidate pre-read. `runReconciliation` now loops candidate batches until a short
  batch or 20 s of wall clock, and its summary reports `batches`.
- 893229a: Docs and examples use the global `Env` that `wrangler types` emits, instead of importing it from `worker-configuration` — that file declares `interface Env` globally and exports nothing, so the documented import never compiled. `test:quickstart` now type-checks the assembled quickstart site against `wrangler types` output, so the README's runtime module cannot drift from what actually compiles.
- 893229a: Schedule rules now combine instead of first-match. `generateSlots` generates from every rule matching the date (deduped on identical start, sorted ascending), so a split day (morning + evening rules) keeps both windows instead of silently dropping every rule after the first. `scheduleForDate` is replaced by `scheduleRulesForDate`, and config validation rejects two rules that share a weekday, overlap seasons and produce the same start time, naming both indices.
- 893229a: Security posture is now reported instead of silently assumed. `OpsHealthResponse` gains `security: { csrfTokenLayer, tokenEncryption, adminAuth }`, and the admin dashboard's Attention area shows a warning card naming the secret to set when the CSRF or token-encryption layer is off. A Cloudflare Access assertion with neither `email` nor `sub` is now rejected (403) with a warning instead of resolving to an empty subject, and reading a secret outside `secretBindings` warns once per isolate per name.
- 893229a: The expired-hold sweep no longer runs an UPDATE on every availability and admin request: it is throttled to once per 60 seconds per isolate, with the reconciliation cron remaining the guarantee. Checkout drops its unconditional sweep and sweeps only when the hold insert reports a capacity conflict, so a just-expired hold still frees the slot immediately.
- 893229a: UI cleanups. Removed the dead message keys `common.back`, `admin.backToAdmin`,
  `common.brandFallback` and `common.time`, and moved the `widget.*` keys (and
  `SLOT_STATUS_MESSAGE_KEYS`) out of the library into the example booking widget that was their only
  consumer, so `ReservaMessageKey` covers only what Reserva renders. `src/ui/tokens.css` is now the
  one place a `--bk-*` default is declared, included by both the pages' stylesheet and the
  components' stylesheet, and `bun run docs:contract` generates the token table in
  `docs/customization.md` from it. `ManageBooking.astro` applies the deployment's own
  `config.ui.messages` before the `messages` prop. Email times follow the locale's hour cycle
  instead of being forced to 24-hour.
- 893229a: `validation_failed` responses now name the field and can carry structured details. `ApiErrorEnvelope.error` gains an optional `details: { field?, allowed? }` (`ApiErrorDetails`), populated by the unknown-service, pricing, date-range, pickup, meeting-point and metadata `select` rejections; `HttpError` takes an optional `details` argument. Five messages were rewritten to start with the offending field. Cancelling a booking that a concurrent reschedule moved now answers `409 invalid_transition` ("booking was rescheduled; reload and try again") instead of `slot_unavailable`.

## 0.4.0

### Minor Changes

- b3bb45d: Add an **Opening hours** tab to the admin settings page. Each service's schedule rule exposes its first and last departure as editable `HH:MM` settings, its departure interval in minutes, and the weekdays it covers as a row of checkboxes (`services.<slug>.schedule.<index>.firstStart` / `.lastStart` / `.intervalMin` / `.days`), stored as overrides like every other setting and validated so the first departure never lands after the last and a rule always keeps at least one day. A stored hours row that a later config edit makes invalid is now dropped on its own instead of discarding every override.
  
  `firstStart` and `lastStart` on a schedule rule are now optional and default to `09:00` and `18:00`.
- 3e25e99: Add a **Pricing** tab to the admin settings page. Every pricing tier of every service exposes its amount as an editable setting (`services.<slug>.pricing.<index>.priceMinor`), grouped per service and labelled by the tier's quantity band and pickup option. Amounts are typed in major units (`150`, `150.50`, or `150,50`) and stored as the integer minor-unit value config already uses, with the currency's own decimal count deciding what is accepted. A tier's `maxQuantity` and `pickup` stay deploy-time.
- 37df70b: Rework the admin dashboard and settings pages around a lighter, one-screen-at-a-time layout.
  
  The dashboard is now three tabs (`?tab=upcoming` / `availability` / `attention`) over a day-grouped booking list. Each booking is a native `<details>` row showing time, customer, service · party size · place, and a status only when it is not confirmed; opening it reveals the reference, contact details, price, pickup and booked-on date alongside a **Manage** link. The bookings table is gone, so the list no longer clips on narrow screens. The availability calendar drops the per-cell `units x/y` label in favour of a state dot, keeping the unit load in the cell's accessible name and tooltip. A header link jumps straight to the attention tab, with a count badge when incidents are open.
  
  Settings now read as sentences: each setting is a plain statement with its value in bold and a **Change** action that swaps in the control. A service's departure window, interval and weekdays collapse into two sentences instead of four separate fields.
  
  Both pages keep working with scripting off. Tabs are real links with every panel server-rendered, rows are native disclosures, and settings render the sentence and its control together, with the browser-side script collapsing the control only once it has run.
- b3bb45d: Publish pricing on the public catalog. Every service in `GET /api/booking/catalog` now carries `pricing` — its rules exactly as configured, each `{ maxQuantity, pickup, priceMinor }` with `pickup` null where the service has no pickup axis — and `fromPriceMinor`, the lowest price across those rules, for rendering a "from" price. Both are projected from the merged runtime config, so admin overrides flow through, and `CatalogService` (plus the new `CatalogPricingRule`) is exported from `@reservajs/astro/core`.
  
  A site can now render prices from the engine instead of keeping its own copy. The catalog still never exposes schedules, turnaround, or capacity, and the amount charged still comes from `/api/booking/quote`.

## 0.3.0

### Added

- `scheduledHandler`, a ready-to-use cron Worker handler for reconciliation.
- Packaged API, configuration, customization, deployment, and development guides.

### Changed

- The optional booking, locale, legal, and admin config blocks now receive defaults.
- Cloudflare runtimes read Reserva's own secrets without requiring consumers to restate them.
- Fresh databases initialize from one consolidated migration; databases upgraded through the
  previous migration chain remain compatible.
- The root and core barrels expose only the supported integration contract.

### Removed

- The `@reservajs/astro/providers` barrel subpath. Import each provider from its own subpath.
- The embeddable `AdminDashboard.astro` component. Use Reserva's injected admin route.

## [0.2.0]

First public release, as `@reservajs/astro`. Everything before it shipped privately under a
different package name; `docs/MIGRATING-v2.md` maps every rename.

### Added

- Generic booking-event layer: `BOOKING_EVENTS` as an exported runtime catalog, in-process
  hooks (fire-and-forget or durable) on the runtime, and outbound webhooks declared in config,
  signed per the [Standard Webhooks](https://www.standardwebhooks.com/) specification and
  delivered from the same durable outbox.
- Headless consumer API surface: `POST /api/booking/quote` (the price checkout charges, with
  nothing stored), `GET /api/booking/catalog` (the rendering contract), and
  `GET /api/booking/ops/health` (schema, outbox debt, open incidents). Every request and
  response shape is an exported type, and every failure code is in the exported
  `API_ERROR_CODES` catalog.
- Optional per-service `location` module (meeting points and pickup options) and declared
  `metadataFields` (four types, three modifiers) — both published through the catalog endpoint
  and validated at checkout.
- `adminAuth` port: admin and operator authorization is a documented callback, with Cloudflare
  Access as the default implementation rather than the only one.
- `config.routes.manage` to disable the built-in manage page while keeping its APIs mounted.
- Provider-agnostic `@reservajs/astro/email` exporting `renderDefaultEmail` and its three
  types, so a non-Brevo transport can reuse the maintained template.
- `@reservajs/astro/ui` subpath for the copy seam (`defaultMessages`, `resolveMessages`,
  `formatMessage`, and their types), moved off the root barrel so importing copy no longer
  pulls the build-time integration into a page bundle.
- `AGENTS.md` ships inside the package as the integration contract. Its route, error-code, and
  event tables — and the README's — are generated from the exported constants, with a CI drift
  check.
- `SECURITY.md`, changesets, and `npm publish --dry-run` for both tarballs in CI.

### Changed

- **The package now ships compiled `dist/` output** (JS + declarations + source maps, with the
  two retained `.astro` components and their CSS copied raw into the mirrored tree). Consumers
  no longer need `vite.ssr.noExternal` or `@types/node`.
- **Stripe is a separate package.** `@reservajs/stripe` exposes a named `stripe(options)`
  factory returning `PaymentProvider`; `@reservajs/astro` has no `stripe` dependency, no Stripe
  implementation, and no payment-adapter subpath. Payment-method selection and Stripe's
  locale/currency/session limits moved to the adapter.
- **Domain rename** (one migration, `0018_v2_domain_rename.sql`): tours became services,
  `people` became `quantity`, `priceCents` became `priceMinor` beside a per-booking `currency`,
  and the vendor's name left the core columns (`paymentSessionRef`, `paymentRef`). Any
  ISO 4217 currency is now supported, with correct zero-decimal handling.
- Error codes lost the vendor prefix: `payment_session_mismatch`, `payment_amount_mismatch`,
  `invalid_payment_signature`. The payment webhook route is `/api/booking/webhooks/payment`.
- Bindings, secrets, virtual module ids, asset routes, the migrate bin, and every exported
  symbol carry the Reserva name.

### Removed

- `BookingWidget.astro` is no longer a package export. The reference funnel lives in
  `examples/smoke-site` and is exercised end-to-end as a real consumer.
- The Tourflow provider and its operator feed, replaced by hooks and signed webhooks.
- Per-entity delivery flags (`calendarSynced`, `emailSynced`, `tourflowSynced`) — delivery state
  lives only in `side_effect_operations` rows — plus the dead `remindedAt`/`reviewRequestedAt`
  fields.

## [0.1.0] - 2026-08-03

- Astro 7 integration for server-rendered tour booking on Cloudflare Workers, D1, and the Cache API, configured via a single `reserva()` call plus a user-owned runtime module for provider construction at request time.
- Injected booking API routes (availability, checkout, Stripe webhook, status, manage, cancel, reschedule, operator actions, feed) and server-rendered `/booking/admin`, `/booking/manage`, and booking-confirmation pages, all server-only with `prerender: false`.
- Provider families for payments (Stripe), calendar (Google), email (Brevo, plus a no-op provider), and tour operations (Tourflow), each importable from its own narrow subpath to keep unused SDKs out of the bundle.
- Embeddable `BookingWidget.astro`, `ManageBooking.astro`, and `AdminDashboard.astro` components, themeable entirely through `--bk-*` CSS custom properties with dark-mode defaults, and a typed, locale-overridable UI copy catalog.
- Durable refund operations backed by a `refund_operations` table with a compare-and-set claim per booking, reconciling operator- and Stripe-dashboard-initiated refunds through one record instead of in-memory state.
- Booking tokens (customer cancel token, operator token) hashed at rest with SHA-256, given a shared expiry, and revoked on cancellation, with optional AES-GCM encryption for manage-link regeneration.
- Admin route protection via Cloudflare Access JWT verification plus independent same-origin CSRF protection (Fetch-Metadata/Origin check and a signed, expiring CSRF token) for admin mutations.
- Route customization options (`routePrefix`, `routes.admin`/`routes.ops`) to remount or selectively disable non-load-bearing route groups.
- `reserva-migrate` CLI wrapping `wrangler d1 migrations apply` for applying the package's D1 migrations to local or remote databases.
- A local interactive demo (`examples/smoke-site`) running the full booking flow against Astro dev, Cloudflare workerd, and persistent local D1 with simulated providers.
