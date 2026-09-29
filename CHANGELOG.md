# Changelog

## 0.13.0

### Minor Changes

- 5b499ee: A new admin tab lists every field with `adminBadge: true` (a partner, a sales channel): each option, even with no bookings yet, with its **Upcoming** count (confirmed bookings still ahead) and **Past** count (confirmed and no-show bookings whose start has passed). Each count opens the bookings list for that value. The tab is named after the field, or "Tags" when several fields are tagged, and doesn't appear when none is.
  
  A select field can declare `adminOptionLink`, a URL with `{value}` in it, to show each option's link with a copy button on that tab, such as a partner's referral link.
- 8db20d1: Every page Reserva renders (confirmation, `/booking/manage`, `/booking/admin`, admin settings) now sends a strict `Content-Security-Policy` header: only same-origin scripts, styles, images, fonts and requests, forms posting back to the site, and no embedding in frames.
  
  **Check this before upgrading if your `ui.headHtml`, `ui.faviconUrl` or `ui.branding.logoUrl` loads anything from another origin** (a font host, a CDN): the browser now blocks it. Set `ui.contentSecurityPolicy` to a policy that allows it, or to `false` to send no header and keep your own. See "Content-Security-Policy" in docs/customization.md.

## 0.12.0

### Minor Changes

- 81a7901: The admin dashboard shows declared fields, refunds and disputes.
  
  - A booking's details list every declared metadata field it has a value for, after the price and in the admin locale, including operator-only fields and on cancelled and no-show bookings, which have no manage link.
  - Fields with `adminBadge: true` tag the booking in the bookings list and the calendar day panel with the option's label, and the raw value once that option is gone.
  - A "Refunded €X" badge and a "Dispute open / won / lost" badge sit beside the status. The details gain matching "Refunded" and "Dispute" rows, with the date the dispute opened.
  - Search matches a select field by the option label it shows, not only by the stored value.
- b91cbf4: Operator-only metadata fields and an opt-in admin tag, two independent settings on a `metadataFields` entry.
  
  - **`visibility: 'customer' | 'operator'`** (default `'customer'`). An `'operator'` field is still validated at checkout and stored on the booking, but is left out of the catalog, the confirmation page and its status payload, the customer's manage page and `/api/booking/manage` answer (both `metadata` and `metadataRows`), and customer emails. The operator's manage view and owner emails still show it. The visitor's browser still sends the value, so treat it as a claim, not a verified fact.
  - **`adminBadge: true`** asks the admin to show the field's value as a tag on the booking. Allowed on `type: 'select'` only; config validation rejects it on any other type, naming the key path.
  - **The customer's `/api/booking/manage` `metadata` now carries only keys the service currently declares as customer-visible.** A value stored under a key that is no longer declared, such as a field removed from config, is no longer returned to the customer; the operator's manage view still has it. The rendered pages and emails already showed declared fields only.
  
  Apart from that last point, a config that sets neither behaves exactly as before.
- b9cb33a: Refund totals and dispute outcomes on every booking.
  
  **Run `bunx reserva-migrate` after upgrading.** Migration `0007_refunds_disputes.sql` adds `amount_refunded_minor`, `disputed_at` and `dispute_status` to bookings, filled from the refunds and disputes already on record (an earlier dispute starts as `open`, since its outcome was never stored). Earlier releases kept a dispute only as the notification it triggered, so one that arrived while no owner email or durable hook was set up for `payment.dispute_created` left nothing to carry over.
  
  **Add `charge.dispute.closed` to your Stripe webhook endpoint.** Without it nothing breaks, but disputes stay `open`.
  
  - `booking.amountRefundedMinor` is the running total of refunds sent on the payment, partial or full, from Reserva or the Stripe dashboard. A partial refund made in the dashboard used to be logged and dropped; it is now recorded and still leaves the booking confirmed. A full refund cancels the booking as before. Events arriving out of order never lower the total.
  - `booking.disputedAt` and `booking.disputeStatus` (`'open' | 'won' | 'lost'`, `null` when never disputed) record chargebacks and bank inquiries. Closing a dispute sends no email and leaves the booking as it is. When a payment is disputed a second time, the booking reopens as `open` with the later dispute's date and then takes its outcome.
  - `PAYMENT_EVENTS` gains `dispute_closed`, and `PaymentEventParsed` gains `disputeOutcome` and `disputeCreatedAt`, the processor's own opening time, which dates the dispute whatever order its events arrive in. `DisputeStatus` and `DisputeOutcome` are exported from `@reservajs/astro/core`. A payment adapter reports `amountRefunded` as the payment's cumulative total.
  - `@reservajs/stripe` maps `charge.dispute.closed`: `won` and `warning_closed` (an inquiry closed without a chargeback) are won; `lost` and `prevented` (settled by refunding the cardholder) are lost. Any other status leaves the dispute open. Both dispute events carry the Stripe dispute's `created` time.

## 0.11.2

### Patch Changes

- 45ba3fe: The admin bookings list opens on a new "Active" filter: confirmed, awaiting payment and no-show bookings. Expired holds (abandoned checkouts) and cancellations no longer crowd the default view; "All" (`?status=all`) still lists every status. Sites that translate the admin into a locale other than en or pt-PT should add `admin.filterActive`.
- 99aa20f: The admin bookings list groups each day into its own card, with the date as a tinted header band, so a day and its bookings read as one unit instead of rows loose on the page background. Cancelled and expired rows get a faint tint on top of their dimmed text. Printing keeps the flat layout.
- 5aa0acc: A new booking's reference now continues from the highest one used that year instead of counting rows. Deleting old bookings (test or abandoned ones) used to restart numbering inside the range already taken, so checkout collided with existing references and could fail after its retries.

## 0.11.1

### Patch Changes

- 424a34c: The admin bookings list labels an exact guest count with its own `admin.guestCount` / `admin.guestCountOne` messages ("3 guests", "1 guest") instead of `widget.quantityCount`. A site that rewords `widget.quantityCount` as "Up to {n} guests" for its "up to N" tiers no longer gets "Up to 3 guests" as the tooltip and screen-reader text of a payer's exact answer. Sites that translate the admin into a locale other than en or pt-PT should add both keys.

## 0.11.0

### Minor Changes

- 40390d7: Admin dashboard redesign.
  
  - **Top bar.** The business name, Dashboard, Settings and the theme switch share one bar at every screen size. The `.bk-sidebar*` classes are now `.bk-topbar`, `.bk-topbar-brand`, `.bk-topbar-nav` and `.bk-topbar-count`.
  - **Theme switch.** Three buttons (System, Light, Dark) replace the single button that cycled through them, on the customer pages too.
  - **Overview.** Cards for today, tomorrow, the next 7 days and bookings awaiting payment, each linking to its view. A banner names the first open incident.
  - **Bookings.** An Upcoming/Past switch, status chips with counts, and one search box (`/` focuses it). There is no Apply button. Day headers say Today or Tomorrow and stay pinned while you scroll. A party-size column shows the exact `guestCount`, "≤N" when a `collectGuestCount` service got no answer, or else the quantity. Cancelled and expired rows are dimmed. An opened row has copy buttons for the reference and email, and a "Manage booking" button.
  - **Availability.** Each day has a load bar, adjusted days have a ring and closed days a struck-through number. Two months show at a time, with a Today button. Drag to select a range, on touch screens too. The selected day opens in a card with its bookings, a capacity stepper, and Reopen for a closed day.
  - **Attention.** Each incident says when it started, which booking it affects and what to do. Technical details are folded away.
  - **Settings.** Wide screens get a side list of sections with a count of changed values. Units sit inside the fields, hints update as you type, and prices are one table per service. The save bar counts unsaved edits and offers Discard.
  
  Message keys. Changed: `admin.title`, `admin.tabUpcoming`, `admin.clear` (now takes `{n}`), `admin.searchPlaceholder`, `admin.attentionCount`, `admin.incidentResolveSubmit`, `admin.incidentHistory`, and the setting labels that used to include a unit. Removed: `admin.overrideDefault`, `admin.addReason`, `admin.searchPlaceholderNoPickup`, `admin.apply`, `admin.unsavedHint`, `admin.incidentSince`. New: `admin.attentionCountOne`, `admin.bannerBooking`, `admin.bannerReview`, `admin.glance*`, `admin.legendLoad`, `admin.legendFull`, `admin.dayOpenBadge`, `admin.dayAdjustedBadge`, `admin.dayClosedBadge`, `admin.dayClosedReason`, `admin.dayPeak`, `admin.dayCancelled`, `admin.dayExpired`, `admin.dayCapacity`, `admin.stepDown`, `admin.stepUp`, `admin.reasonOptional`, `admin.selectHintTouch`, `admin.reopen`, `admin.reopenHint`, `admin.today`, `admin.clearMany`, `admin.manageBooking`, `admin.guestsUpTo`, `admin.holdUntil`, `admin.copyReference`, `admin.copyEmail`, `admin.copied`, `admin.modifiedCount`, `admin.unsavedCountOne`, `admin.unsavedCount`, `admin.noUnsaved`, `admin.discard`, `admin.pricePeople`, `admin.pricePartySize`, `admin.price`, `admin.incidentAttemptsOne`, `admin.incidentDetected`, `admin.openBooking`, `admin.incidentTodo.*`, and a `setting.<key>.unit` for each numeric setting.
- fff54ea: Exact guest count for "up to N" services.
  
  **Run `bunx reserva-migrate` after upgrading.** Migration `0006_guest_count.sql` adds a `guest_count` column to bookings.
  
  - Set `collectGuestCount: true` on a service to ask the payer how many people are coming. The field is optional and never blocks payment.
  - The answer is stored as `booking.guestCount`. Price and capacity still follow `quantity`.
  - `@reservajs/stripe` adds it as an optional numeric field on Stripe Checkout. Change its label with `guestCountFieldLabel`.

## 0.10.0

### Minor Changes

- 50b8530: Admin dashboard fixes.
  
  - **One bookings list.** Choose Upcoming or Past (`?when=`), then filter by status or search within that period. "All" now includes every status, so a status filter can never show more rows than "All". Upcoming starts at midnight in the business timezone, so bookings from earlier today stay visible.
  - **Paging.** 50 rows per page with "Showing X–Y of Z". A search reads up to 20,000 bookings and says so if it stops there. The "Show later bookings" link and `?until=` are gone.
  - Filters, tabs, day links and page links keep the current list state. Filter options have their own labels ("Awaiting payment", "No-show", …).
  - **Calendar.** Each day shows the most units in use at the same time against capacity, plus the number of bookings (`2/2 peak · 3 bookings`), across the whole booking horizon. The calendar is one Tab stop with arrow-key navigation. With JavaScript, multi-day selection replaces the "To date" field.
  - A blank capacity is rejected instead of closing the day. Settings resets are validated like saves, Enter in a settings field saves, and schedule `days` are sorted and de-duplicated.
  - A failed admin action returns to the same page with a readable message instead of JSON. An expired form says "This page expired". Access and Origin failures still return 403.
  - The Attention badge shows the real number of open incidents. Retry is hidden where it can't help (oversell, payment verification, reconciliation).
  
  Removed message keys: `admin.all`, `admin.showLaterBookings`, `admin.unitsLoad`. New: `admin.whenLabel`, `admin.whenUpcoming`, `admin.whenPast`, `admin.filterAll`, `admin.filterConfirmed`, `admin.filterHold`, `admin.filterExpired`, `admin.filterCancelled`, `admin.filterNoShow`, `admin.noPastBookings`, `admin.noMatchingBookings`, `admin.pageRange`, `admin.pagination`, `admin.pagePrev`, `admin.pageNext`, `admin.searchTruncated`, `admin.dayLoad`, `admin.bookingCountOne`, `admin.bookingCount`, `admin.dayOpen`, `admin.incidentsTruncated`, `admin.errorGeneric`, `admin.errorInvalid`, `admin.errorInvalidField`, `admin.errorExpired`, `admin.errorNotFound`.
- 50b8530: Confirmation and manage page fixes.
  
  **Run `bunx reserva-migrate` after upgrading.** Migration `0005_calendar_patch_outbox.sql` adds a `calendar_patch` outbox family (ops health can now report it).
  
  **Breaking:** `icsText` and `icsDataUrl` from `@reservajs/astro/ui` now take a second argument, `{ uid, generatedAt }`. Use `calendarUid(reference, businessUrl)` for the `uid`.
  
  - A reschedule succeeds as soon as the booking moves. The calendar update now goes through the outbox (retried, then raised as an incident), so a calendar outage no longer turns a finished reschedule into a 500. The incident is titled "Calendar not updated".
  - Rescheduling to the time the booking already has succeeds without doing anything, so a double-submitted form no longer errors.
  - The reschedule calendar no longer counts the customer's own booking against capacity. Availability accepts the booking's manage token in the `x-reserva-manage-token` header (`MANAGE_TOKEN_HEADER`, or `manageToken` on the client). That answer is never cached.
  - The reschedule picker no longer fails with a 400 when its range crosses a daylight-saving change.
  - After cancelling, the customer sees a "Booking cancelled" page instead of "Link not valid".
  - The manage page shows both the cancel and the reschedule deadline, and says when one has passed. Form errors come back as a readable message, and buttons are disabled while a form is sending.
  - The confirmation page keeps waiting after a server error instead of saying the booking wasn't found. With JavaScript it checks the status in the background and announces progress to screen readers. `?locale=pt` now finds `pt-PT`.
  - Calendar files use one UID per booking (`<reference>@<your host>`), so two bookings at the same time no longer clash. `DTSTAMP` is the time the file was made.
  - Multi-day bookings show their end date. After the 4-hour detail window, the page no longer says a confirmation email is on its way.
  - Customer pages get a "Skip to content" link, and the theme toggle works on every confirmation and manage page.
  - Checkout's metadata errors include `details.field` (`metadata.<key>`) for every rule.
  - The low-availability hint now reads "Room for {n} more bookings", with a new singular key `widget.limitedOne`. If you override `widget.limited`, override `widget.limitedOne` too.
  - `createReservaClient({ base })` accepts a trailing slash.
  - Stripe: the default success URL includes `&locale=`.
  
  New message keys: `widget.limitedOne`, `confirmation.pollChecking`, `confirmation.pollUpdated`, `confirmation.summaryLead`, `manage.reschedulePolicy`, `manage.cancelClosed`, `manage.rescheduleClosed`, `manage.cancelDoneTitle`, `manage.cancelDoneBody`, `manage.cancelDoneRefund`, `manage.bookAgain`.
- 50b8530: Theme fixes: token overrides work as documented, focus is easier to see, and branded pages read well in dark mode.
  
  **Breaking:** the `--bk-focus` token is removed. Focus is now a solid 2px outline in `--bk-accent`, which also shows in Windows forced-colors mode. Styles that used `var(--bk-focus)` need their own ring.
  
  - A plain `:root { --bk-accent: … }` (or `.bk-embed { … }` for the component) now wins in dark mode too. Before, the dark defaults beat it.
  - `<ManageBooking />` no longer changes the host page's colors. Its tokens live on `.bk-embed`, and it follows `data-theme` on any ancestor, otherwise the OS setting.
  - New `--bk-accent-text` token for accent-colored text, used by the accent badge and the ticket month, now at 4.5:1 contrast. If you override `--bk-accent` alone, set `--bk-accent-text` too, or those stay indigo.
  - `ui.branding.accentColor` gets a lighter version in dark mode, just light enough to read (`#0f6b3f` becomes `#448c69`).
  - Printed pages always use the light palette.
  - The page assets are cached for a year only under their current `?v=` hash, so a stale URL is never cached.
  - A list in the masthead no longer overlaps the text above it.
  - `ui.branding.fontFamily` and `mastheadBackground` reject an unclosed `(`, `[` or quote, which used to break the rest of the stylesheet.

## 0.9.0

### Minor Changes

- 7f5d276: Customer pages can now be customized without CSS workarounds.
  
  - **Structured messages.** In the confirmation page's `*Body` messages, `confirmation.detailsEmailed`, `manage.invalidBody` and `manage.invalidUseEmailLink`, a blank line starts a new paragraph and consecutive `- ` lines become a `<ul class="bk-list">` with a hanging indent. The text is escaped first, so messages still can't carry HTML. A message with neither renders exactly as before.
  - **Page hooks.** `<body>` carries `bk-page--confirmation` / `bk-page--manage` / `bk-page--admin` / `bk-page--settings`. On the confirmation page it also has `data-bk-status` set to the status state, and on the manage page `data-bk-status` is the booking's status. Cards gain `bk-whatsnext`, `bk-summary`, `bk-message`, `bk-contact`, `bk-reschedule`, `bk-cancel` and `bk-no-show`. These names are public and stable across minor versions (see `docs/customization.md`).
  - **`ui.branding`** for the confirmation and manage pages: `logoUrl` (+ `logoWidth`/`logoHeight`) renders an `<img>` in the masthead with the business name as alt text. `colorScheme: 'light' | 'dark'` pins the palette and drops the theme toggle. `accentColor` (hex) sets the accent and a computed contrast color. `mastheadBackground` and `fontFamily` are also available. The values are added to the served stylesheet, scoped to the customer pages, so pages still need only `style-src 'self'`. Operator pages are unchanged.
  - **`ui.confirmation.statusPlacement: 'masthead' | 'ticket'`** (default `'masthead'`): `'ticket'` moves the confirmed badge into the top-right of the booking ticket.
  
  For a deployment that sets none of these options, the only output change is the new hook classes and attributes. The stylesheet gains the `.bk-list`, `.bk-brand-logo` and `.bk-ticket-status` rules.

## 0.8.1

### Patch Changes

- f64cfad: Admin settings edits now also apply to the scheduled job. The cron ran on `reserva.config.ts` alone, so a `booking.reminderHoursBefore` changed on `/booking/admin` never affected reminders, and emails the cron sends (reminders, retried confirmation and cancellation emails) quoted the file's cancellation cutoff while the same email sent from a web request quoted the admin value. `scheduledHandler` now reads the same merged settings as every route; an invalid stored row still falls back to the file value with a `reserva.settings.invalid_override` warning.
  
  Links in cron-sent emails now honour `routePrefix`. With `reserva({ routePrefix })`, the manage link in a retried customer or owner email and the admin link in an operational alert pointed at the unprefixed path; they now use the same paths as the routes.
  
  A custom `scheduled()` that builds its own context for `runReconciliationWithLease` should wrap it in the newly exported `withStoredSettings` from `@reservajs/astro/runtime` and set `routeConfig` from `virtual:reserva/config`; `docs/deployment.md` shows the snippet.
  
  The Guests value in booking emails is now the copy key `value.guests` (default `'{quantity}'`, so output is unchanged). A per-vehicle site can set it through `config.emails.messages`, e.g. `en: { 'value.guests': 'Up to {quantity} guests' }`; it applies to the customer and owner cards, including the reminder.

## 0.8.0

### Minor Changes

- 295ae19: Partial refunds. `refund` on the operator cancel request accepts `partial` alongside `none` and `full`, with `refundAmountMinor` (at least 1, below the booking price) naming the amount. Migration `0004_partial_refunds.sql` widens the `refund_operations.choice` CHECK and adds `requested_amount_cents`, so a reconciler retry replays the decided amount rather than the booking price; two `partial` requests for different amounts are different decisions and the loser gets `409 refund_conflict`. Still one refund per booking, decided at cancellation.
  
  The Stripe adapter now sends `amount` explicitly on every refund instead of relying on Stripe's refund-the-remainder default. A refund that is mid-retry across the upgrade presents the same idempotency key with different parameters and fails until the key ages out (~24h), then succeeds on a fresh attempt — visible as a refund incident, never a double refund.
  
  Message keys `manage.refundPartial`, `manage.refundAmount`, `manage.refundAmountHint` added. Email copy `refund.timing` reworded to make no claim about how much is returned.

## 0.7.0

### Minor Changes

- 3afca1a: Admin settings: two-column form with every control always editable. Unsaved edits are flagged on the field and in a sticky Save bar. Message keys `settingStmt.*`, `admin.changeValue`, `admin.doneEditing` removed; `admin.unsaved`, `admin.unsavedHint` added.

## 0.6.0

### Minor Changes

- f107671: Business-wide opening hours and formula pricing, so a fleet operator states its day and its
  pick-up surcharge once instead of once per service.
  
  - `hours` at the top level is inherited by every service that declares no `schedule`; each
    service still derives its own last departure from a shared `lastEnd`.
  - A service's `pricing` may now be a formula `{ baseMinor, surcharges?, maxUnits?, surchargeScope? }`:
    `baseMinor` per capacity unit (`occupancy.seatsPerUnit` seats), times the units the party
    needs, plus the chosen pickup option's surcharge, per unit or per booking. Undeclared fields
    inherit the top-level `pricing: { surcharges, maxUnits, surchargeScope }` block. Breakpoint rows
    are unchanged and remain the way to express a non-linear price curve.
  - The admin Hours tab edits the shared block as one statement, closing time included; the Pricing
    tab edits the shared surcharges, group size, and one base price per formula service. Values a
    service declares for itself sit under a folded "Service-specific overrides" disclosure.
  - **Breaking:** the catalog's `pricing` is now `CatalogPricingRule[] | CatalogPricingFormula`, and
    every service also publishes `maxQuantity`. `priceFor`, `resolvedPriceTableFor` and
    `pricingCombinations` accept both shapes; `lowestPriceMinor`, `maxQuantityFor`,
    `isPricingFormula` and `unitsFor` are new on `@reservajs/astro/core`. Stored admin override rows
    that no longer match a setting are dropped with a load warning. See `docs/MIGRATING-v2.md`.

## 0.5.2

### Patch Changes

- 790d645: `reserva-migrate --remote` works again. The derived-config arguments added `--persist-to`
  unconditionally, but that flag names a *local* persistence directory and wrangler rejects it under
  `--remote` ("Cannot use --persist-to without --local"), so the documented way to migrate a
  production database — runbook step 1, and any CI step that applies migrations before deploying —
  failed every time. It is now omitted for a remote run; a local run still gets its own persistence
  root so projects do not share one.

## 0.5.1

### Patch Changes

- 160d94b: Fixes from the first 0.5.0 consumer upgrade.
  
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

## 0.5.0

Breaking release. `docs/MIGRATING-v2.md` has the step-by-step upgrade.

### Breaking

- One config source. The integration validates `reserva.config.ts` and ships the result through
  `virtual:reserva/config`. Runtime factories no longer take a config argument, and
  `runtimeEntrypoint` defaults to `./src/reserva-runtime.ts`.
- `services.<slug>.occupancyFor` is replaced by `occupancy: { seatsPerUnit }`.
- `services.<slug>.title` is required and localized. So are meeting-point and pickup labels.
- Pickup ids are opaque. The special `default` and `custom` ids are gone; address collection keys
  off `requiresAddress`, and every option needs a `label`.
- Request fields are `serviceSlug`, `pickup`, `start` and `sessionId` everywhere. The old
  spellings still work for one minor and log a deprecation.
- The cron runs inside the site Worker. Export `fetch` and `scheduled` from your own
  `src/worker.ts` and set `main` and `triggers.crons` in `wrangler.jsonc`. The separate cron Worker
  and its duplicated secrets are gone.
- Provider options have one name each. See the rename tables in the migration guide for Stripe,
  Google Calendar and `verifyAccessJwt`.
- `reserva()` no longer declares provider secret names in `env.schema`. Declare the ones you want
  typed yourself.
- Hook handlers receive `(event, booking | null, context)` and must declare all three parameters.
- `widget.*` message keys moved out of the library into the example widget. Four dead keys removed.
- New migrations: `0002_payment_verification_incidents.sql` and `0003_reconciliation_lease.sql`.
  Run `bunx reserva-migrate`.

### Added

- `@reservajs/astro/client`: a typed, browser-safe API client. Every failure is a
  `ReservaApiError` with `status`, `code` and `details`. Calendar helpers ship from the same entry.
- `@reservajs/astro/dev`: `devProviders()` runs the whole flow in `astro dev` with no external
  accounts.
- `astro dev` bypasses the admin gate automatically when `admin.access` is set. Production builds
  always call Access.
- Email alerts out of the box. `emailAlertSink` is wired to `business.contact.email` whenever the
  email provider can send a plain message, so `requireAlertSink: false` is no longer needed.
- `POST /api/booking/ops/reconcile` runs the sweep on demand. A D1 lease stops it from overlapping
  the cron, and ops health reports the last run and opens a `reconciliation_stale` incident when
  the cron stops.
- Reminder email before the start. `booking.reminderHoursBefore`, default 24, editable in admin.
- `settings.changed` webhook, fired once per admin save, so a static site can rebuild.
- `lastEnd` on schedule rules: say when the last booking must be over instead of computing the
  last departure by hand.
- `meta` passthrough on services and meeting points, echoed by the catalog.
- `paymentDeadline` on checkout, `cancelDeadline` and `rescheduleDeadline` on manage, and a
  `ConfirmationSummary` from status once the detail window closes.
- `ui.faviconUrl` and `ui.headHtml`.
- Pricing helpers `resolvedPriceTableFor` and `pricingCombinations` exported from `core`;
  `priceFor` no longer depends on row order.
- Formatting helpers exported from `ui`; availability slots carry business-local `date` and `time`;
  `quantity` is optional on availability.
- Security posture on ops health and a warning card on the dashboard when a secret is missing.
- Structured `details` on `validation_failed` errors, and messages that name the field.

### Fixed

- Schedule rules on the same day now combine instead of first-match, so a split day keeps every
  window.
- A completed-but-unpaid checkout (a delayed payment method) is refused: hold released, payment
  cancelled, incident opened. A late settlement is refunded in full.
- The confirmation page stops polling after about a minute and shows contact details. A rejected
  payment shows a `failed` state instead of spinning.
- Customer pages and emails: start and end times, calendar buttons on the manage page, an `.ics`
  attachment, clearer error copy, a shared contact block, WhatsApp links, dispute mail for the
  owner.
- Admin: contact links on rows, phone and metadata search, an `expired` filter, retry outcomes,
  hold expiry badges, print styles, and a dashboard capped at a quarter with a link to widen it.
- Database: narrower occupancy reads, conflict-safe reference generation, throttled hold sweep,
  and reconciliation that loops batches until done.
- A Cloudflare Access assertion with no subject is rejected instead of passing as an empty user.
- The schema fingerprint is generated from the migrations and committed, so the runtime check can
  no longer drift from the SQL. `reserva-migrate` cleans up after itself and checks for wrangler.
- Docs use the global `Env` from `wrangler types`, which is the only form that compiles.

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
