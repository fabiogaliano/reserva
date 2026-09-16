# @reservajs/astro review — 2026-09-16

Scope: `src/`, `packages/stripe`, docs, examples, and the mazetours consumer
(`~/Core/dev/projects/mazetours/website`, pinned to 0.3.0; lib is at 0.4.0).
Findings ranked by impact. `file:line` refs are against bookkit `main` unless prefixed `mazetours/`.

## P0 — correctness

1. **Only the first matching schedule rule generates slots.** `src/core/slots.ts:27` uses `find`, so two rules for
   the same weekday never union. The shipped `examples/configs/fitness-studio.ts:22-25` (07–09 + 18–20, both Mon–Fri)
   never offers evening classes. `validateConfig` does not reject it either. Fix: `filter` + merge starts, or reject.
2. **Async Stripe payment methods break confirmation.** `packages/stripe/src/provider.ts:70` allows only `card | mb_way`.
   Any async method (Multibanco, SEPA) yields `checkout.session.completed` with `payment_status: 'unpaid'`, which
   `verifyPayment` turns into `409 payment_amount_mismatch` (`src/handlers/webhook.ts:33-35`), the code docs say to page on.
   `checkout.session.async_payment_succeeded/failed` are not mapped (`provider.ts:254-255`). Blocks the Portuguese market.
3. **Catalog `title` is not locale-resolved as documented.** `src/handlers/catalog.ts:81` is `service.title ?? slug`.
   `title`, meeting-point `label`, pickup `label/hint` are plain strings; only `metadataFields[].label` is `LocalizedText`.
   Mazetours works around this with `tourName()` slug title-casing + Stripe `getServiceName` (`mazetours/src/reserva-runtime.ts:51-64`).
4. **Customer-facing pages show the slug, not the title.** `src/ui/pages/manage-page.ts:63`, `confirmation-page.ts:52-53`
   (ICS title). `ManageBooking`/`ConfirmationBooking` wire types carry no `serviceTitle`.
5. **Hidden magic pickup ids.** `catalog.ts:26-31` special-cases `'default'`/`'custom'`; `''` is the location-less key
   the consumer must know (`mazetours/src/components/BookingFunnel.astro:27`). Contradicts "ids are per-service config".
6. **`validation_failed` promise violated.** "Unknown service", "No price is configured…", "Date range is empty" name no
   field (`availability.ts:153,168`, `checkout.ts:42,213`, `quote.ts:15`). Cancel losing a CAS returns `slot_unavailable`
   (`booking-actions.ts:51`).
7. **Confirmation page pending state never times out.** Meta-refresh every 3 s forever (`confirmation-page.ts:93`);
   a failed verification also reports `pending` (`status-manage.ts:108-110`).

## P1 — API ergonomics (biggest consumer wins)

8. **No typed client.** Mazetours hand-rolls fetches, casts JSON, re-declares `Slot` wrongly (`remainingBookings`, a
   field that does not exist, so "1 spot left" never renders — `BookingFunnel.astro` script l.12/214), and shows raw
   `error.message` to customers. Ship `@reservajs/astro/client`: `createReservaClient({ base })` with typed methods,
   `ReservaApiError { status, code, message }`, `isApiError()`. Would delete ~250 lines of the funnel.
9. **Export `src/ui/format.ts`** (`formatPrice`, `formatDateTime`, `formatDayDate`, `googleCalendarUrl`, `icsDataUrl`) from
   `./ui`. Every consumer reimplements `Intl` formatting and `start.slice(11,16)`.
10. **Naming drift across endpoints.** `pickup` (quote/catalog) vs `pickupType` (checkout/wire); `?service=` vs
    `serviceSlug`; `start` / `newStart` / `startsAt`; `?session_id=` vs camelCase; `token` / `operatorToken`. Unify,
    keep aliases for one release.
11. **Availability/calendar helpers.** Consumers rewrite month chunking, timezone day-keys, `isDateDisallowed`, "first
    open day" (`BookingFunnel.astro` script 77-116, 404-467). Publish `localDate`/`localTime` on `AvailabilitySlot`
    (already on `GeneratedSlot`), make `quantity` optional, and export a `availabilityCalendar()` helper or an
    `AvailabilityResponse` → cally bridge since `cally` is already a dependency.
12. **Pricing helpers.** Mazetours enumerates `priceFor` per (pickup × quantity) at build to ship a price table and
    notes `priceFor` depends on row order (`BookingFunnel.astro:22-38`). Export `priceTable(service)`; make `priceFor`
    pick the tightest tier regardless of order (or sort at validation).
13. **Contract gaps:** `CheckoutResponse.holdExpiresAt`; `QuoteResponse` breakdown (`unitPriceMinor`, `quantity`);
    `ManageResponse.rescheduleDeadline` (currently always the cancel deadline, `status-manage.ts:186`);
    `StatusResponse.booking` goes `null` after 4 h so a bookmarked confirmation goes blank; `QuoteRequest.locale` is
    accepted and ignored (`api.ts:93`); error envelope has no structured `details` (valid ids), forcing regex on `message`.
14. **`AdminAuth` cannot redirect.** Returns `{subject} | null`; a human gets a JSON 403. Mazetours wrote
    `admin-demo-auth.ts` + `admin-login.ts` + middleware (≈160 lines) around it. Allow returning a `Response`, or add
    `onUnauthorized`. Ship `sharedSecretAdminAuth({ secretBinding })` for solo operators and local dev; it also removes
    the "swap `admin.access` and `adminAuth` as a pair" cutover dance (`mazetours/reserva.config.ts:97-103`).
15. **Config is passed twice and can drift.** Validated in `integration.ts:129` and again in
    `runtime-context.ts:185` from whatever object the consumer imports. Serialize `ClientConfig` through
    `virtual:reserva/config` (already done for route flags) and drop the first arg of `defineCloudflareReservaRuntime`.
    Blocker: `occupancyFor` is a function; make it declarative (`occupancy: { unitsPerBooking | unitsPerPerson }`).
16. **Default `runtimeEntrypoint` to `./src/reserva-runtime.ts`** (`integration.ts:20`).
17. **Core hardcodes vendor secret names** (`STRIPE_*`, `BREVO_*`, `GOOGLE_*`) in `integration.ts:32-39` while Stripe
    lives in a separate package. Let providers declare their env schema.
18. **Adapter option alias sprawl.** `provider.ts:38-56` (5 spellings for the line-item name), `calendar-google/auth.ts:15-33`,
    `access.ts:17-24`, four export names for one class (`calendar.ts:169-173`). Pick one each before 1.0.
19. **`resolveMessages(undefined, locale)`** awkward for the common case; `ManageBooking.astro:18` ignores
    `config.ui.messages`.
20. **Business-level shared `meetingPoints` + passthrough fields.** Mazetours asserts every service has identical points
    (`BookingFunnel.astro:74-89`) and keeps a parallel `MEETING_POINTS_GEO` for coords. Allow `business.meetingPoints`
    referenced by id, and an `extra`/`meta` bag on config entities and services (`description`, `imageUrl`) surfaced
    in the catalog so the consumer's per-slug parallel table disappears.

## P1 — config DSL

21. **Per-person pricing** needs one row per headcount (`fitness-studio.ts:27-32`); mazetours generates 8 rows per
    service with `(base + surcharge) * tuktuks` (`reserva.config.ts:55-70`). Add `unit: 'person' | 'booking'` and a
    per-pickup-option `surchargeMinor`; keep breakpoints as override. Add `minQuantity`.
22. **Capacity is global.** Two services with separate fleets share one pool; `occupancyFor` is the only workaround.
    Add `service.capacity` or a `resources` concept.
23. **Schedule limits.** No `lastEnd` (mazetours hand-rolls `hhmm()` for close − duration, `reserva.config.ts:36-42`),
    no explicit `starts: ['09:30','14:00']`, `from/to` are month-day only (no absolute date ranges, no config blackout
    dates), `days` as ints.
24. **Pickup model is flat.** Mazetours decodes 4 ids into two questions (collect/drop) with a `PICKUP_ID` map and
    computes "+€20" deltas by diffing prices. Consider `axis`/`group` metadata or the surcharge model in 21.
25. Minor: `capacity.default: 0` allowed silently; `capacity.default` silently overridden by an admin-set default
    (author had to comment it, `mazetours/reserva.config.ts:83-89`); `legal` has no privacy URL; `contact.whatsapp` unvalidated.

## P1 — operations / DX

26. **Scheduled reconciliation needs a second Worker with every secret duplicated** (`docs/deployment.md:138-147`,
    `mazetours/worker/`). Docs claim `scheduled()` cannot live in the site Worker; Astro 7's custom fetch entrypoint
    (`src/fetch.ts`, referenced in AGENTS.md) may allow a `scheduled` export — verify and, if so, ship a template.
    Mazetours also had to make its runtime module Vite-free (`tour-durations.ts:1-5`) just for this Worker.
27. **No shipped `OperationalAlertSink`**; `scheduledHandler` requires one (`reconciliation.ts:399`), so every
    consumer sets `requireAlertSink: false`. Ship `alertsViaEmail(provider)` / `alertsViaWebhook(url)`.
28. **No reminder emails** and no `booking.reminder` event. Outbox + cron already exist; add per-service
    `reminderHoursBefore`.
29. **Local dev fakes are not exported.** `examples/smoke-site/src/runtime.ts` fakes (~150 lines) and mazetours'
    `simulated-payments.ts` are the same thing. Ship `@reservajs/astro/testing` with in-memory payment/email/calendar/
    alert fakes, plus the payment-port contract test. Document `stripe listen --forward-to …`, `.dev.vars`, seeding.
30. **Missing providers:** offline/manual payment ("pay at meeting point", bank transfer — most valuable; core half
    supports via `no_payment_required`), Resend/Postmark/SES, CalDAV (Outlook/Apple), PayPal.
31. **Stripe adapter:** default `cancel_url` is `${business.url}/services/${slug}` which the lib does not own
    (`provider.ts:220-222`); no pinned `apiVersion` so `charge.refunded` shape (`refunds.data`, `provider.ts:169-174`)
    floats per account; hidden contract requirements (`bookingId` in metadata, idempotent refund) undocumented in
    `PaymentProvider` (`events.ts:118-133`).
32. **Security posture is invisible.** CSRF token layer silently off without `RESERVA_CSRF_SECRET`
    (`admin-csrf.ts:100-101`); `cloudflareAccessAdminAuth` returns `subject: ''` when JWT lacks email/sub
    (`access.ts:124`) weakening CSRF binding; `RESERVA_TOKEN_ENC_KEY` one-way door not in the secrets table. Add a
    `security` block to ops-health and log once.
33. **`secrets(name)` returns `undefined` silently** for names not in `secretBindings` (`runtime-context.ts:235-239`).
34. **Migrations:** single `0001_init.sql`; fingerprint hand-maintained in `schema-check.ts:52-160` — any future ALTER
    needs a matching probe or valid DBs throw "collision". Derive fingerprint from `migrations/*.sql` at build.
    `reserva-migrate` leaves `.reserva-migrate.<uuid>.jsonc` on Ctrl-C and fails late without wrangler on PATH.
35. **Perf:** `listUpcoming`/`listAllFrom` unbounded + AES-GCM decrypt per row (`repo.ts:1769-1783`);
    `sweepExpiredHolds` UPDATE on every availability/checkout/admin GET (`availability.ts:250`, `checkout.ts:225`,
    `admin.ts:54`); occupancy loads full rows incl. tokens (`repo.ts:1760`); reference-collision retry loop instead
    of `INSERT … ON CONFLICT`; reconciliation caps 50 sources per run (300 owed emails drain in 30 min).

## P2 — admin dashboard UX

36. Email/phone in rows are plain text, not `mailto:`/`tel:` (`admin-page.ts:238-239`); manage page does link them.
37. Search misses phone and metadata (`admin-page.ts:62`); status filter omits `expired` (`:355`).
38. Upcoming-only list; past bookings only via a typed filter that silently switches to a 365-day scan
    (`handlers/admin.ts:56-71`). No today/week/day view of the list; the per-day list sits under Availability.
39. No manual booking, no per-booking notes, no CSV/print (`theme.ts` has no `@media print`), no per-service or
    per-slot capacity breakdown (`admin-page.ts:283-292`), no today quick-stats.
40. Retry outcome invisible: always "Retry attempted. Refresh…" (`admin.ts:181`) though `admin.ts:180` knows the result;
    `admin.incidentRetryFailed`/`NotAvailable` messages never rendered.
41. Day tooltip is `title=` only (invisible on touch, `admin-page.ts:337`); `formatDayDate` omits year across New Year
    (`format.ts:24-35`); holds visually near-identical to confirmed rows; "First seen" absolute vs promised relative.
42. No JSON operator read API (list/search) → headless admin, CSV, iCal feed impossible. Admin is HTML-only.

## P2 — customer pages and emails

43. No end time/duration rendered anywhere customer-facing though `end` is in the payload (`status-manage.ts:33,67`).
44. Manage page lacks add-to-calendar; confirmation calendar buttons vanish after the 4 h grace.
45. Reschedule fallback is a bare `datetime-local`; JS path defaults locale to `'pt-PT'` (`manage-enhancer.ts:44`).
46. `en` → US date order on pages while emails upgrade to `en-GB` (`render.ts:39`); email time forced `h23` (`render.ts:81`).
47. Manage error mapping covers 3 codes (`manage-page.ts:117-121`); `refund_failed` shows "nothing was changed" (false).
    Past-cutoff "contact us" renders no contact details. Invalid-token page asks for a "token" customers never have.
48. Emails: no `.ics` attachment (`RenderedEmail` is `{subject, html, text?}`, `render.ts:28`; generator exists in
    `format.ts:85`); confirmation omits price/reference/cancel policy from the card (`render.ts:161-169`); WhatsApp not
    a `wa.me` link; no operator email on `payment.dispute_created`; branding is five colours + logo with no footer slot.
49. Lib pages have no favicon/head injection or layout slot (`layout.ts:32` not exported); mazetours decisions doc
    notes this. Manage-link host is always `business.url` (404 pre-cutover).
50. Theming: 937-line `theme.ts`, token set documented by example only; `components.css:5-45` duplicates the token
    block; dead message keys (`common.back`, `admin.backToAdmin`, `common.brandFallback`, `common.time`, …);
    two locales with two separate fallback chains (`email/copy.ts:117-131` vs `messages.ts:279-307`).
51. Tests: no axe pass; confirmation `pending/expired/cancelled` states uncovered (only `not_found`, `tests/e2e/errors.spec.ts:11`).

## Suggested order

1. P0 #1 (schedule union) + validation test; P0 #2 (async Stripe methods); P0 #7 (pending timeout).
2. `LocalizedText` for title/labels + `serviceTitle` on wire types (#3, #4).
3. `@reservajs/astro/client` + export `format.ts` + availability helpers (#8, #9, #11, #12).
4. Unify field names (#10) and fill contract gaps (#13).
5. `AdminAuth` → Response + shared-secret auth (#14); alert sink + testing fakes (#27, #29).
6. Per-person pricing, surcharges, per-service capacity, declarative occupancy → single-config runtime (#15, #21, #22).
7. Reminders, offline payment provider, admin JSON API + manual booking (#28, #30, #42, #39).
