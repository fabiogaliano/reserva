# Test-audit ledger — surfaces lane

Scope: `src/ui/`, `src/email/`, `src/components/`, `src/client/`, `src/providers/`, plus the example
widget (`examples/smoke-site/src/components/BookingWidget.astro`) and every Playwright spec.
Read-only pass, 2026-09-29. Baseline `baseline-unit.json`: 1211 tests, 0 failed. No retained test in
this lane fails on the baseline.

CI routing: unit files run in the Vitest `unit` project; `tests/component/*` in `component` (Astro
Vite pipeline); `tests/e2e/*` in Playwright (`playwright.config.ts`, one worker, one shared D1 +
outbox, the smoke site via `e2e-dev-server.ts`). `bun run verify` (CI) runs `generate:check`,
`typecheck` (tsc: includes `tests/` and `examples/`, but not `.astro` files), `docs:contract:check`,
`test`, `test:workers`.

Marks: R retain · F retain, repair assertion · C consolidate into named owner · D delete.

Totals: **250 declarations — R 195 · F 31 · C 13 · D 11.**

---

## tests/ui-booking-widget.test.ts (15: R2 F3 C4 D6)

These are all greps of the example widget's source and CSS. The widget is the smoke site's own
component, not shipped library code. The file header says the harnesses can't observe these
properties, but most of them are now proven directly by e2e specs added later.

| line | mark | evidence |
|---|---|---|
| 20 computes no price | C | Absence-greps pass vacuously whatever a new identifier is called. The positive grep `toMajorUnits(result.priceMinor…` breaks on a rename. Owners: component `booking-widget-catalog:26` (data island keys are only `i18n`, `locale`) and e2e `maze-pickup-options:66` (quote shows 210, the server-stored confirmation shows 210). |
| 33 no scarcity threshold | C | e2e `widget-checkout:167` mocks `limitedThreshold 2` with remaining 1/2/null and expects exactly two hints, so a local threshold would fail it. The negative greps here are vacuous. |
| 43 no hardcoded pickup table | C | Owners: component `booking-widget-catalog:33` (no server-side pickup/meeting-point fields) and e2e `maze-pickup-options` (declared ids `custom_both`/`custom_dropoff`/`custom_pickup` flow through). |
| 53 wire types import | R | Design-law guard: the reference consumer uses the exported wire types. tsc does not check `.astro`, so this source check is the cheapest independent guard. |
| 61 form starts hidden | D | e2e `widget-resilience:6` aborts the module: the form stays hidden and the fallback stays visible. Every other widget spec proves the script reveals the form. |
| 66 noscript fallback | F | The only guard for the `<noscript>` block, but it greps source text. Repair: in `booking-widget-catalog`, render the component and assert the `<noscript>` holds non-empty copy and the contact link when contact props are passed. |
| 76 reveal after awaited init | D | e2e `widget-resilience:21` (catalog abort leaves the fallback up) and `:29` (a corrupt island leaves its own fallback up, sibling unaffected). The test also greps a `console.error` message string (`'its fallback stays visible'`). |
| 82 loading affordance | F | A regex over the template source. Repair: component render with the availability endpoint, then assert the disabled submit button's text equals the catalog `widget.loadingSlots` value. |
| 86 noscript key in catalog | C | The catalog is `as const`, so the test's own index access is tsc-checked, which makes the test circular. It is absorbed once the line-66 repair asserts the rendered noscript copy is non-empty. |
| 96 meetingPoint key in catalog | D | component `booking-widget-catalog:64-67` asserts `i18n.meetingPoint` in the rendered island. |
| 102 syncMeetingPoints wiring | F | The change-listener, hide and disable greps are proven by e2e `meeting-points:21` and `maze:181` (group hidden, radios disabled, payload omits `meetingPointId`). Keep only the init-time ordering claim (no e2e service starts on a non-meeting-point option), or drop it. |
| 113 `.bkw-field[hidden]` CSS | D | e2e `meeting-points:35` and `maze:189` use `toBeHidden()` on that `bkw-field` fieldset (created by `radioGroup`, className `bkw-field`). If `display:block` won the cascade, both would fail. |
| 117 `.bkw-retry[hidden]` CSS | D | e2e `widget-resilience:68` ("Retry stays hidden until availability actually fails") was added in the same commit 50b8530 as this grep. |
| 123 resolveMessages(virtualConfig.config) | R | The only guard that deployment `ui.messages` overrides reach the widget's library keys. Cheapest independent check. |
| 128 meetingPointId payload | D | e2e `meeting-points:48` and `maze:101/154/193` assert the checkout body carries or omits `meetingPointId` as expected. |

## tests/ui-format.test.ts (5: R5)

| line | mark | evidence |
|---|---|---|
| 7 omits current year | R | Public `formatDayDate` (`@reservajs/astro/ui`). Catches a year always or never printed. |
| 11 names other year | R | Same. Regression: next January read as this January. |
| 17 same-day range | R | Public `formatDateTimeRange`. Expected string is hand-derivable. |
| 22 cross-day range | R | End-date branch. |
| 27 business-tz day decision | R | Catches a UTC-vs-Lisbon day boundary bug. |

## tests/ui-layout.test.ts (3: R2 F1)

| line | mark | evidence |
|---|---|---|
| 15 favicon once | R | The only test of `pageShell` favicon (config `ui.favicon`). Catches a duplicated or missing link. |
| 19 headHtml after library CSS | R | Cascade-order contract for consumer overrides. Only test. |
| 27 emits neither when unset | F | The name says "neither" but only the favicon is checked. Add an assertion that nothing lands after the library stylesheet link, or rename. |

## tests/ui-manage-page.test.ts (11: R2 F7 C2)

| line | mark | evidence |
|---|---|---|
| 46 both deadlines stated | F | The contract is which notice renders, with the cutoff formatted in the business tz. It asserts full English sentences, so a copy edit breaks it. Repair: build the expected text from `formatMessage(messages['manage.…'], {date})`, or add the state as a snapshot row. |
| 52 reschedule closed | F | Same. The structural checks (`data-reserva-reschedule` absent, mailto) are sound. Replace the prose sentences. |
| 60 cancel closed | F | Same. `not.toContain('Yes, cancel this booking')` is a prose negative that turns vacuous after a copy edit. Use the cancel form hook instead. |
| 68 reschedule disabled | F | `not.toContain('Online rescheduling closed')` turns vacuous after a copy edit. Assert against the catalog value. |
| 74 combined notice | F | Same prose pattern. |
| 83 ?error= inherited keys | F | Prototype-key regression pin, keep it. Assert `messages['manage.error…generic']` rather than the literal sentence. |
| 92 enhancer loads | R | Script-tag markup contract. Catches the enhancer being gated on canReschedule. |
| 97 skip link | C | `ui-page-snapshots` pins `<a class="bk-skip" href="#bk-main">Skip to content</a>` in all 10 documents, manage included. |
| 101 scarce-slot wording | R | Catalog regression pin ("seats" vs "bookings", singular form, en and pt-PT). Here the copy is the contract. |
| 111 cancelled page | C | component `customer-page-routes:100` renders the same page through the real route and asserts reference, refund note, Book again link and no token. Carry `data-bk-status="cancelled"` and the mailto check across by adding a cancelled-page row to `ui-page-snapshots`. |
| 121 free booking: no refund note | F | `not.toContain('refund')` passes vacuously if the copy drops that word. Assert the absence of `messages[<refund-note key>]`. |

## tests/ui-messages.test.ts (3: R1 F2)

| line | mark | evidence |
|---|---|---|
| 11 pt-PT complete, placeholders match | R | Catalog parity contract. Enumerates the runtime catalogs, not a copied list. |
| 20 English default | F | Contract: default locale and pt-PT selection. Compare against `defaultMessages['widget.date']` and `ptCatalog['widget.date']` instead of literal copy. |
| 28 override layering | F | The override assertions are the test's own inputs (good). Line 41 compares against the literal pt-PT copy; use `ptCatalog['widget.loadingSlots']`. |

## tests/ui-page-customization.test.ts (17: R17)

| line | mark | evidence |
|---|---|---|
| 52 messageHtml plain | R | Structure parser, byte-identical for plain messages. |
| 58 list/paragraph structure | R | Parser branches. |
| 65 escape before structure | R | XSS contract. |
| 71 whatsNext via ui.messages | R | Override reaches the card through the real renderer. |
| 83 confirmation hook classes | R | Public styling hooks (body class, data-bk-status, section classes) that consumers target from headHtml. Explicit guard beyond the snapshot. |
| 93 manage hook classes | R | Same. |
| 107 statusPlacement ticket | R | Config option behavior. |
| 114 placement fallback, no ticket | R | Fallback branch. |
| 126 logo img | R | Branding markup on both page families. |
| 134 colorScheme pins scheme | R | The pinned scheme overrides the viewer cookie and the toggle is dropped. |
| 143 auto follows viewer | R | Also absorbs `ui-theme:176` (forced theme on `<html>`). |
| 149 admin keeps own theme | R | Superset of `ui-theme:191`. |
| 166 brandingCss scope | R | Override tokens are scoped to customer pages only. |
| 180 accentContrastColor | R | Pure logic. Expected values are hand-checkable extremes. |
| 186 cssAssetHref versioning | R | Cache-busting contract. |
| 194 assets route serves branding | R | Route-level order: defaults, then branding. |
| 201 branding validation | R | CSS-injection guard in `validateConfig`. No duplicate in `core-config.test.ts` (grep). Could move there later. |

## tests/ui-page-snapshots.test.ts (3: R3)

| line | mark | evidence |
|---|---|---|
| 45 confirmation states (it.each, 8 rows) | R | Page snapshot suite, retention bar. |
| 63 manage confirmed | R | Same. |
| 75 manage invalid link | R | Same. |

## tests/ui-theme-tokens.test.ts (17: R15 F2)

| line | mark | evidence |
|---|---|---|
| 30 :where() defaults | R | Zero-specificity contract. Catches a consumer's `:root` override losing. |
| 37 forced theme after OS rule | R | Source order is the observable behavior at equal specificity. |
| 41 dark palette off paper | R | Print contract. |
| 49 embed tokens are generator output | F | The first assertion (committed file equals `renderEmbedTokensCss(tokens.css)`) duplicates `bun run generate:check`: `UI_TOKEN_OUTPUTS` includes `src/ui/generated/embed-tokens.css` and CI runs it via `verify`. Keep only the `@import './generated/embed-tokens.css'` assertion. |
| 54 embed scoped to .bk-embed | R | Host `:root` never touched. |
| 64 host data-theme before OS | R | Order contract. |
| 75 no outline:none | R | Forced-colors a11y guard. Cheap source inspection. |
| 82 focus ring reads var(--bk-accent) | R | Regression pin (frozen `:root` ring). |
| 90 3:1 focus contrast | R | Computed from generated tokens, not copied. |
| 100 accent text 4.5:1 | R | Same. |
| 108 masthead list 4.5:1 | R | Same. |
| 117 dark palette per accent (it.each) | R | Invariant over the inputs. |
| 127 light accent-text (it.each) | R | Same. |
| 134 lightens only as needed | F | `toEqual({accent:'#448c69',…})` is copied from a run of `darkAccentPalette`, which is a junk pattern. Assert minimality instead: the result clears 4.5:1 and one nudge step less does not. Keep the untouched `#f5c518` case. |
| 139 dark variant emission | R | Media and selector structure plus ordering. The hex literal is copied (same caveat as line 134), but the structure is the contract. |
| 155 CSS immutable caching | R | Cache-header contract per version. |
| 164 JS immutable caching | R | Same. |

## tests/ui-theme.test.ts (21: R13 F3 C3 D2)

| line | mark | evidence |
|---|---|---|
| 17 no cookie → undefined | R | `readThemePreference`, used by `route-context.ts`. |
| 22 parses light/dark | R | Also pins the cookie name `bk_theme` that `theme-toggle.ts` writes as a literal. |
| 29 rejects unknown value | R | Untrusted cookie input. |
| 34 exposes cookie name | D | Restates the constant (`themeCookieName` must equal `'bk_theme'`). Line 22 already fails if the name drifts from the enhancer's literal. The `export` exists only for this test (see seams). |
| 40 OS media query + :where selector | R | Partly overlaps tokens:37/41, but those don't fail if the `:not([data-theme])` selector goes missing (indexOf -1). |
| 45 forced palette + color-scheme | F | `'--bk-accent: #7c86e2;'` is a hex copied from `tokens.css` and could match anywhere in the sheet. Derive it from `darkTokenValues['--bk-accent']` and scope the search to the `:where(:root[data-theme="dark"])` block. |
| 52 toggle styling + [hidden] guard | R | The `[hidden]` guard regression is not reached by any e2e (no theme-toggle spec). |
| 57 panel measure + `.bk-panels > [hidden]` | R | No-script tab contract. |
| 67 meters/legend classes, chevron | F | The CSP-motivated class contract (meter `data-fill` classes, legend classes, single-declaration counts) is worth keeping. The pure layout literals (`grid-row`/`grid-column` for guests/status/chevron, hover rule) pin styling and break on a behavior-preserving restyle. Trim them. |
| 92 field tags no dot | R | Design decision with a named regression. Cheap. |
| 99 admin tabs + one open row | R | Enhancers have no executed-behavior harness (architecture: deferred), and no e2e covers one-row-open. |
| 107 resolve note deferred | R | Only partly implied by `admin-incidents.spec:90` (the first press reveals the note). The spec would likely still pass if the note were never hidden. |
| 114 day peak in card | R | No other guard. |
| 120 rebuilt field tags order | R | No other guard. |
| 133 settings dirty + savebar | F | e2e `admin-settings.spec` already proves dirty badge, `data-dirty`, save disabled/enabled, discard hidden, reset, and `[hidden]` CSS effects (`toBeHidden`). Keep only the sticky savebar and `beforeunload` assertions, or move `beforeunload` into the e2e (it registers a dialog handler but never asserts the dialog fired). |
| 152 toggle hidden, System pressed | C | `ui-page-snapshots` pins `data-reserva-theme-toggle hidden` with System `aria-pressed="true"` and the Light/Dark labels in all 10 documents. |
| 162 forced choice pressed | R | No snapshot renders with a viewer theme. Only guard. |
| 170 pageShell OS: no data-theme | C | Snapshot: all 10 documents are `<html lang="en">` with the toggle inside `bk-masthead-inner`. |
| 176 forced theme on masthead page | C | `ui-page-customization:143` (confirmationPage, `viewerTheme: 'dark'` gives `data-theme="dark"` plus the toggle). The snapshot pins toggle placement in the masthead. |
| 183 admin topbar placement | R | No admin page snapshot. Only guard. |
| 191 admin handler viewerTheme | D | `ui-page-customization:149` makes the same `handleAdminGet` call with `viewerTheme:'dark'` and asserts the same two strings, plus body class and no logo. |

## tests/ui-vendor-cally.test.ts (1: R1)

| line | mark | evidence |
|---|---|---|
| 21 bundle matches installed version | R | The only staleness guard. `scripts/vendor-cally.ts` is not in `generate:check`. Possible strengthening: compare bundle bytes, not just the version. |

## tests/email-render.test.ts (16: R10 F2 C2 D2)

| line | mark | evidence |
|---|---|---|
| 28 branding overrides | R | Public `renderDefaultEmail` (`@reservajs/astro/email`) plus `emails.branding`. |
| 39 neutral default branding | C | `email-render-snapshot` pins `background-color:#1a1a1a` 48 times and has zero `<img`. |
| 45 refund.timing override (en) | F | The negative is vacuous: `'Refunds are returned to your original payment method.'` has not existed in `copy.ts` since 295ae19 (the default is now `'Any refund due is returned…'`). Compare against the current catalog default, or assert exactly one refund-timing sentence. |
| 55 refund.timing override (pt-PT) | F | Same: `'Os reembolsos são devolvidos…'` no longer exists (current: `'Qualquer reembolso devido…'`). |
| 66 full custom renderer | D | Self-comparison: the test defines a function, calls it, and checks what it returned. No production code runs. Brevo's use of `renderEmail` is proven by `providers-email:81/102`. |
| 76 custom renderer delegates | D | Only proves `renderDefaultEmail` is deterministic for identical input. The delegation is the test's own code. Same remaining proof as line 66. |
| 93 ics customer-only + address-only location | R | Attachment routing plus a location-selection regression. |
| 112 UID by reference@host, DTSTAMP | R | Regression pin (DTSTAMP used to copy the start). |
| 132 guests bare quantity (it.each) | R | `value.guests` default across three templates. |
| 142 guests override (it.each) | R | Override interpolation. |
| 156 override escaped | R | XSS contract. |
| 185 operator-only metadata absent (it.each) | R | Privacy boundary. |
| 194 owner keeps operator metadata | R | Same. |
| 203 customer-visible field to both | R | Same. |
| 214 free-cancellation deadline ahead | C | `email-render-snapshot` pins `Free cancellation until` in 8 places (fixture createdAt is far ahead of the cutoff). |
| 218 booked inside cutoff | R | Unique branch (the late-booking notice). |

## tests/email-render-snapshot.test.ts (4: R4)

Email snapshot suite, retention bar (all four rows).

## tests/client.test.ts (19: R19)

Public `@reservajs/astro/client`. No other test suite covers it (grep `createReservaClient`: only here plus the widget).

| line | mark | evidence |
|---|---|---|
| 62 catalog locale query | R | Wire shape. |
| 74 availability query + no-store | R | Stale-slot regression. |
| 84 range split + merge | R | `availabilityChunks` against the 62-day cap. Expected chunks are hand-derivable. |
| 106 quantity only when asked | R | |
| 112 manage token in header | R | Token never goes in the URL. |
| 123 checkout verbatim JSON | R | |
| 133 status/manage uncached, encoded | R | |
| 145 bearer on operator/ops | R | Auth contract. |
| 170 no bearer on customer route | R | Secret-leak guard. |
| 178 no auth header without bearer | R | |
| 186 base prefix | R | |
| 192 trailing slash | R | Regression (`//`). |
| 198 paths table fallback | R | |
| 207 paths+base refused | R | Remediating error. |
| 213 envelope → ReservaApiError | R | Error envelope. |
| 224 non-envelope → internal_error | R | Closed code set. |
| 243 network → status 0 | R | |
| 252 non-JSON 2xx | R | |
| 259 isReservaApiError | R | |

## tests/providers-email.test.ts (20: R18 F1 C1)

| line | mark | evidence |
|---|---|---|
| 44 localized customer + owner posts | R | Brevo transport, routing, headers. The subject prose (`'Reserva confirmada'`) is incidental but also the locale proof. |
| 64 resolved manage path | F | Contract is sound. It passes the `fetchImpl` alias instead of `fetch`, and is that alias's only caller. Use `fetch`. The public alias itself stays (see follow-ups). |
| 81 renderer callback + locale fallback | R | Custom renderer wiring. Owner for the email-render D rows. |
| 90 Stripe `auto` locale | R | Fallback regression. |
| 98 emailNone no-op | R | Public provider entry. Thin, but not assertion-free. |
| 102 recipient roles + guarded single send | R | Routing table plus nohash URL blanking. |
| 128 5xx capped + retryable | R | Outbox retry classification. |
| 148 4xx permanent | R | Same. |
| 166 nohash omits manage link | R | The `nohash:` and `href=""` negatives are real. The prose negatives are supplementary (they would go vacuous after a copy edit). |
| 187 chosen meeting point | R | Renderer passes the booking's id (regression: always read the single point). |
| 201 removed point → snapshot label, no map | R | Fallback resolution is owned by `core-config:604`. The render-side gate (no "Open map" when mapsUrl is null) is unique to the email renderer. |
| 217 address-only option | R | Render gate. |
| 233 both flags | R | Render gate. |
| 251 single declared point unchanged | C | `email-render-snapshot` (location-ful rows) pins `Praça do Comércio`, `maps.google.com/?q=Praca+do+Comercio` and `Open map` for exactly this fixture. |
| 263 manage URL escaped | R | XSS. |
| 293 metadata rows both cards | R | |
| 310 no metadata on cancellation | R | |
| 320 metadata XSS | R | |
| 340 sendMessage + failure | R | Operational-alert transport. |
| 353 ics forwarded as attachment | R | Transport mapping (renderer ics is a separate owner). |

## tests/providers-google.test.ts (14: R14)

| line | mark | evidence |
|---|---|---|
| 51 token create + cache + JWT claims | R | Public provider (`clearGoogleTokenCache` is public via `export *`). |
| 68 single-flight | R | Concurrency regression. |
| 92 event mapping | R | The only public path (`listEvents`). |
| 108 list filter + REST verbs + bearer | R | |
| 134 chosen meeting point in description | R | Renderer passes the id. |
| 147 removed point fallback | R | Resolver is owned by `core-config`. The maps-line gate is calendar-specific. |
| 161 address-only | R | |
| 175 both flags | R | |
| 190 409 → already created | R | Idempotent create. |
| 199 status/retryable classification | R | Outbox. |
| 228 token failure classification | R | |
| 248 pagination | R | |
| 265 page cap | R | Runaway guard. |
| 276 429 retry once | R | |

## tests/component/booking-widget-catalog.test.ts (10: R7 F3)

| line | mark | evidence |
|---|---|---|
| 26 island carries only i18n+locale | R | The render-level "no local price or threshold" guard (keeper for ui-booking-widget:20). |
| 33 no server-side pickup fields | R | Keeper for ui-booking-widget:43. |
| 43 endpoints from route table | R | Route manifest wiring. |
| 51 explicit endpoints | R | |
| 57 empty price element | R | |
| 64 legends in locale | F | Asserts literal copy (`'Where do we meet?'`, `'Choose a meeting point'`). Compare against `defaultWidgetMessages[...]` (keep the pt differs check). Keeper for ui-booking-widget:96. |
| 74 party sizes 1..maxQuantity | R | Regression (fixed 1..4). |
| 81 explicit quantityOptions | R | |
| 88 error copy in locale | F | Same literal-copy pattern on `errorSlotUnavailable`. The pt loop is sound. |
| 99 English with no locale | F | `aria-label="Book now"` is incidental prose. `name="locale" value="en"` alone carries the contract. |

## tests/component/customer-page-routes.test.ts (10: R6 F4)

| line | mark | evidence |
|---|---|---|
| 28 server error stays on waiting page | F | Regression contract (500 keeps polling, not "not found"). Replace the prose (`'Confirming your payment'`, `'Booking not found'`) with `data-bk-status="pending"` and not `data-bk-status="not_found"`. The refresh regex is sound. |
| 38 attempt cap | F | Assert `data-bk-status="pending"` plus the timed-out hook instead of `'Still waiting for the payment provider'`. |
| 45 no sessionId → not found | F | Use `data-bk-status="not_found"`. |
| 51 locale negotiation | R | `lang` attribute. |
| 63 strict CSP on pages | R | CSP contract, markup scan. |
| 80 CSP on cancelled page | R | |
| 89 horizon across DST | R | Regression pin. |
| 100 cancelled page from customer cancel | R | Route-level keeper for `ui-manage-page:111`. Headers, token absent, revocation 403. The prose is part of what it proves. |
| 119 operator 303 → cancelled | F | `'This booking has been cancelled.'` should be `data-bk-status="cancelled"`. |
| 135 bounce to ?error= (it.each) | R | Form error UX contract. |

## tests/component/instance-ids.test.ts (2: R1 D1)

| line | mark | evidence |
|---|---|---|
| 21 BookingWidget distinct ids | D | e2e `instance-ids.spec:6` proves the same pair (distinct `.bkw-label` ids, `calendar-date aria-labelledby` resolving to its own) on one real page, plus independent operation. |
| 33 ManageBooking distinct ids | R | The only guard for the shipped `ManageBooking.astro` component. |

## tests/component/manage-body-limit.test.ts (1: R1)

| line | mark | evidence |
|---|---|---|
| 9 413 at route | R | Route-entrypoint body cap (helper unit tests don't prove the route calls it first). |

## tests/e2e (58: R54 F3 C1)

These are the library-validating integration tests. All are retained unless they replay an identical flow.

| spec:line | mark | evidence |
|---|---|---|
| admin-day-select:30 contiguous pointer range | R | a11y semantics plus the D1 override result. |
| admin-day-select:71 scattered selection | R | The two form shapes never mix. |
| admin-day-select:106 last day can't be toggled off | R | |
| admin-day-select:125 plain click drops hidden toDate | R | Regression. |
| admin-day-select:145 drag range | R | Touch-path proxy. |
| admin-day-select:173 keyboard selection | R | Keyboard parity. |
| admin-day-select:219 single tab stop, arrow nav | R | |
| admin-day-select:245 pager crosses window | R | Latest window fix (d4cd131). |
| admin-incidents:14 incidents lifecycle | F | Strong contract (alerts once per revision, no PII keys, retry, manual note, history). It leans on prose: card titles `'Calendar not updated'`/`'Booking may exceed capacity'`, `'no automatic retry is available'`, `'Marked as handled'`, `'Resolved manually by'`. Swap in data hooks or role and regex. Keep the `abandoned` never-shown check (a deliberate vocabulary guard). |
| admin-settings:5 dirty/discard/save/reset | R | Keeper for `ui-theme:133`. |
| admin:7 dashboard row → operator manage | F | `getByText('Operator view')` is an incidental copy assertion. `h1 'Dashboard'` too. Use a structural operator marker (e.g. the operator-only refund combobox, or a role hook). |
| admin:26 close/reopen day override | R | |
| availability-race:6 stale response race | R | Regression. |
| availability:20 availability wire shape | R | |
| availability:48 remaining countdown + sold out | R | Capacity end to end. |
| booking-metadata:10 metadata through funnel + escaping | R | |
| booking-metadata:52 required field blocks submit | R | |
| booking-metadata:74 blank optional omitted | R | |
| booking-metadata:88 400 names field | R | Remediating error. |
| confirmation-poll:10 poller replaces meta refresh | R | |
| customer-manage:6 cancel, revocation indistinguishable | R | |
| customer-manage:49 Referer never leaks token | R | Security regression. |
| customer-manage:69 reschedule | R | |
| customer-manage:93 manage token header | R | |
| customer-manage:108 month-at-a-time fetch | R | |
| customer-manage:134 negative-tz dateKey | R | Regression. |
| errors:3 garbage token page | R | |
| errors:14 unknown sessionId | R | |
| errors:25 payment webhook path | R | Route manifest. |
| funnel:4 happy path | R | Canonical smoke (outbox event plus manage). |
| funnel:27 widget negative-tz dateKey | R | Regression (different code from customer-manage:134). |
| instance-ids:6 two widgets | R | Keeper for component instance-ids:21. |
| location-less:7 no location axis | R | Checkout body plus manage JSON are the strong proof. The prose negatives are supplementary. |
| location-less:55 checkout rejects pickup | R | |
| maze:66 210 € combined option server truth | R | Quote equals checkout price. |
| maze:146 custom drop-off second point + address | R | |
| maze:181 custom pick-up hides/disables group | R | Keeper for meeting-points:21. |
| meeting-points:8 second point label | R | Overlaps maze:146 (second point survives), but through the default option. Keep. |
| meeting-points:21 custom pickup hides/disables | C | Identical flow to `maze:181`: a `usesMeetingPoint:false` option hides the group, disables its radios, and the checkout omits `meetingPointId`. Both services now declare `pickupOptions` (smoke `config.ts:40-43` and `:62-67`), so maze's "legacy pair" rationale is stale. The only extra is the reload-re-enables check. |
| operator:6 full refund cancel | R | |
| operator:36 partial refund in major units | F | The name promises "the amount typed in major units is what gets refunded", but it asserts only `status: cancelled` and an unchanged `priceMinor`. The major-to-minor conversion (`src/routes/booking/manage.ts:130`, `Math.round(major * factor)`) has no test asserting 5.50 becomes 550. Rename, or add a component test in `customer-page-routes` whose fake payment provider records the refund amount. |
| operator:64 reschedule | R | |
| widget-checkout:20 no double checkout | R | Regression. |
| widget-checkout:76 bfcache restore | R | Regression. |
| widget-checkout:104 failure copy table (6 rows) | R | Here code-to-localized-copy is the contract. |
| widget-checkout:112 network copy | R | |
| widget-checkout:119 availability network copy | R | |
| widget-checkout:130 availability vs checkout copy | R | |
| widget-checkout:141 slot_unavailable refresh | R | |
| widget-checkout:150 field-targeted error | R | |
| widget-checkout:167 scarcity counts bookings | R | Keeper for ui-booking-widget:33. |
| widget-party-size:7 up to maxQuantity | R | |
| widget-party-size:18 capped below 4 | R | |
| widget-resilience:6 module abort keeps fallback | R | Keeper for ui-booking-widget:61. |
| widget-resilience:21 catalog failure keeps fallback | R | Keeper for ui-booking-widget:76. |
| widget-resilience:29 corrupt island isolation | R | |
| widget-resilience:68 Retry hidden until failure | R | Keeper for ui-booking-widget:117. |
| widget-resilience:97 fallback styled without host tokens | R | Regression. |

---

## Layer plan

**Redundant layer 1: `tests/ui-booking-widget.test.ts` (source greps of the example widget).**
It was written when the widget had no browser coverage. Its greps now shadow behavior proven by
the e2e specs and the component render test. Target state: the file keeps only line 53 (wire-type
import) and line 123 (`resolveMessages(virtualConfig.config)`), plus the init-order remnant of
line 102 if wanted. The noscript and loading-button checks move to
`tests/component/booking-widget-catalog.test.ts` as render assertions.
- Keeper, no local price: `booking-widget-catalog:26` + e2e `maze:66`.
- Keeper, no local scarcity threshold: e2e `widget-checkout:167`.
- Keeper, catalog-driven pickup: `booking-widget-catalog:33` + e2e `maze`.
- Keeper, reveal-after-init / fallback: e2e `widget-resilience:6/21/29`.
- Keeper, `[hidden]` CSS rules: e2e `meeting-points:35`, `maze:189`, `widget-resilience:68`.
- Keeper, meetingPointId payload: e2e `meeting-points:48`, `maze:101/154/193`.

**Redundant layer 2: unit string-matching of rendered HTML that the page snapshot suite already pins.**
- Toggle markup and `<html>` without `data-theme` (`ui-theme:152/170`), skip link (`ui-manage-page:97`): keeper `ui-page-snapshots`.
- Forced `data-theme` (`ui-theme:176`) and the admin viewerTheme wiring (`ui-theme:191`): keeper `ui-page-customization:143/149`.
- Cancelled page (`ui-manage-page:111`): keeper `customer-page-routes:100` + a new cancelled row in `ui-page-snapshots`.
- Manage deadline/closed notices (`ui-manage-page:46-74`): keep the tests (they own the state→notice selection and tz formatting), but stop asserting literal English. Derive the expected text from the catalog, or turn the five states into snapshot rows (preferred: one owner of copy).

**Redundant layer 3: email renderer unit tests vs `email-render-snapshot`.**
- Default branding (`email-render:39`), deadline-ahead row (`email-render:214`) and single-point location (`providers-email:251`): keeper `email-render-snapshot`.
- Custom-renderer "tests" (`email-render:66/76`): keeper `providers-email:81/102` (the only production consumer of `EmailRenderer` in the repo).

**Layer 4: meeting-point resolution replayed per renderer** (email, calendar description, manage/status handlers).
The resolver `meetingPointForBooking`/`pickupPresentationFor` is owned by `core-config.test.ts:577-678`.
The provider tests stay because each renderer has its own gate on `mapsUrl`/`requiresAddress`, and the
regression was renderer-side (ignoring the booking's id). No change.

**Layer 5: settings enhancer.** The `ui-theme:133` greps are covered by e2e `admin-settings.spec`, except
the sticky savebar and `beforeunload`. Trim the greps.

**Layer 6: generator drift.** `ui-theme-tokens:49` first assertion vs `bun run generate:check` (keeper).

**e2e duplicates:** exactly one: `meeting-points:21` duplicates `maze:181`.

### Test-only production seams

Checked with grep over `src/`. Public surface checked against `package.json` `exports`, `src/index.ts`,
`src/ui/index.ts` (messages and format only), `src/email/index.ts`, `src/client/index.ts`,
`src/providers/*/index.ts`.

- `themeCookieName` (`src/ui/theme.ts:1305`): its only non-test reference is the same file (line 1313).
  `theme.ts` is not re-exported by any package entry. Deleting `ui-theme:34` unlocks dropping the
  `export` keyword (keep the const). Not public, so no changeset needed beyond the empty one.
- `renderEmbedTokensCss` (`scripts/generate-ui-tokens.ts:60`): used in-file by `UI_TOKEN_OUTPUTS`, and imported
  only by `tests/ui-theme-tokens.test.ts:4`. After the line-49 F repair, the `export` can go. Tooling, not package.
- Not seams (public, keep): `clearGoogleTokenCache` (`export *` from the calendar-google entry), the
  Brevo `fetchImpl` option (public `BrevoEmailProviderOptions`). Its only in-repo caller is
  `providers-email:66/77`. Removing it is an API change that needs a changeset.
- `callyVersion`: consumed only by the test, but it is the generated staleness stamp itself. Keep.
- `contrastRatio`/`darkAccentPalette`/`lightAccentPalette`/`accentContrastColor`: internal-only exports whose
  tests are legitimate value tests of non-obvious logic. Keep.

---

## High-confidence batch

All are test-only edits in the `unit` and `component` projects. The e2e keepers are unchanged.
Commit with `changeset add --empty`, except for the optional seam export removals below.

### B1. `tests/ui-booking-widget.test.ts` — delete 6 declarations
- **Names/locations:** `:61` "starts the form hidden…", `:76` "reveals the form only after the awaited init…", `:96` "ships the widget.meetingPoint legend key…", `:113` "a disabled meeting-point group actually renders display:none…", `:117` "Retry actually renders display:none while hidden…", `:128` "submit payload includes meetingPointId only when…".
- **Failure detected:** a source string, regex, CSS literal or console message is missing. None of these assertions run code.
- **Non-test callers:** n/a (source greps of `examples/smoke-site/src/components/BookingWidget.astro` / `booking-widget.css`; no production seam).
- **Stronger remaining proof:** e2e `widget-resilience:6` (form hidden when script blocked), `:21`/`:29` (fallback kept on failed or corrupt init), `widget-resilience:68` (Retry hidden before failure), `meeting-points:35` + `maze:189` (`toBeHidden` on the `bkw-field` group), `meeting-points:48` + `maze:101/154/193` (payload `meetingPointId` present or absent), component `booking-widget-catalog:64-67` (`i18n.meetingPoint`).
- **History:** greps from e4f8b22 (catalog-driven widget, 2026-09-01), 578a622 (meeting-point group, 2026-08-13) and 50b8530 (triage, 2026-09-27). 50b8530 added the Retry e2e and the Retry CSS grep together.
- **Deletion unlocked:** none in production. Shrinks the file toward the two retained design-law greps.
- **Risk / validation:** Low. The e2e keepers are Playwright-only, so a regression surfaces at `bun run test:e2e` instead of `bun run test`. `bun run test tests/ui-booking-widget.test.ts`; `bun run test tests/component/booking-widget-catalog.test.ts`; `bun run test:e2e tests/e2e/widget-resilience.spec.ts tests/e2e/meeting-points.spec.ts tests/e2e/maze-pickup-options.spec.ts`.

### B2. `tests/email-render.test.ts:66` and `:76` — delete (custom-renderer self-comparisons)
- **Failure detected:** none in production. Line 66 calls a function the test itself defines. Line 76 checks `renderDefaultEmail(x)` equals `renderDefaultEmail(x)`, i.e. determinism.
- **Non-test callers:** `EmailRenderer` is consumed by `BrevoEmailProvider` (`src/providers/email-brevo/index.ts:92`, `options.renderEmail ?? renderDefaultEmail`).
- **Stronger remaining proof:** `providers-email:81` (the renderer callback is invoked with the context and the fallback locale), `:102` (the renderer receives recipient and blanked URLs, and its output is sent).
- **History:** reached this file in b3f866b (2026-09-01) as documentation of the public seam.
- **Deletion unlocked:** none (public type).
- **Risk / validation:** Very low. `bun run test tests/email-render.test.ts tests/providers-email.test.ts`.

### B3. `tests/ui-theme.test.ts:191` — delete (admin viewerTheme wiring duplicate)
- **Failure detected:** `handleAdminGet` doesn't reflect `viewerTheme`, or drops the toggle.
- **Non-test callers:** `createReservaContext` / `handleAdminGet` (production routes).
- **Stronger remaining proof:** `ui-page-customization:149` makes the identical call and assertions (`data-theme="dark"`, `data-reserva-theme-toggle`) plus admin body class and branding isolation.
- **History:** d808b73 (2026-07-22). The superset test came in 7f5d276 (2026-09-25).
- **Deletion unlocked:** none. Imports `createReservaContext`, `handleAdminGet`, `fakeRepository`, `providers`, `D1Database` become unused in `ui-theme.test.ts`.
- **Risk / validation:** Very low. `bun run test tests/ui-theme.test.ts tests/ui-page-customization.test.ts`.

### B4. `tests/ui-theme.test.ts:34` — delete, and un-export `themeCookieName`
- **Failure detected:** the constant's literal value changes.
- **Non-test callers:** `themeCookieName` is referenced only inside `src/ui/theme.ts:1313`. It is not re-exported from any package entry.
- **Stronger remaining proof:** `ui-theme:22-26` parse real `bk_theme=…` cookies, so they fail if the server's name drifts from the literal `theme-toggle.ts:14/17` writes.
- **History:** d808b73.
- **Deletion unlocked:** the `export` on `src/ui/theme.ts:1305`. This is a shipped source change: commit it separately as structural, with an empty changeset (not public).
- **Risk / validation:** Very low. `bun run test tests/ui-theme.test.ts`; `bun run typecheck`.

### B5. `tests/ui-theme-tokens.test.ts:49`: F (drop the generator-drift assertion)
- **Failure detected:** `embed-tokens.css` is out of date with `tokens.css`.
- **Non-test callers:** `renderEmbedTokensCss` is used by `UI_TOKEN_OUTPUTS` in `scripts/generate-ui-tokens.ts`.
- **Stronger remaining proof:** `bun run generate:check` (`scripts/generate.ts` iterates `UI_TOKEN_OUTPUTS`, which includes `src/ui/generated/embed-tokens.css`). It runs in CI via `verify`.
- **History:** generated-tokens introduction. `generate.ts` later absorbed UI tokens.
- **Deletion unlocked:** the `export` on `renderEmbedTokensCss` (tooling), and the test's `readFileSync(tokens.css)` / import.
- **Risk / validation:** Low. `bun run generate:check`; `bun run test tests/ui-theme-tokens.test.ts`.

### B6. `tests/email-render.test.ts:45` and `:55`: F (vacuous negatives)
- **Failure detected (today):** only the positive half. The negatives check strings removed from `src/email/copy.ts` in 295ae19 (2026-09-18).
- **Repair:** assert the override replaced the catalog default, `not.toContain(<resolved default refund.timing for the locale>)`, by reading the default from the catalog (e.g. render once without the override and pick out the sentence, or import the copy entry).
- **Risk / validation:** Low. `bun run test tests/email-render.test.ts`.

### B7. Snapshot-absorbed unit assertions: C
- `ui-theme:152`, `ui-theme:170`, `ui-manage-page:97` → `ui-page-snapshots` (all 10 documents pin the toggle group, `<html lang="en">` without `data-theme`, and the skip link).
- `email-render:39`, `email-render:214`, `providers-email:251` → `email-render-snapshot` (48× `background-color:#1a1a1a`, 0 `<img`; 8× `Free cancellation until`; the Praça/maps/Open map strings for the single-point fixture).
- `ui-theme:176` → `ui-page-customization:143` + snapshot.
- **Risk:** medium-low. A snapshot is easier to re-record blindly than an explicit assertion, but the design law makes the snapshot the owner of markup and copy. Validate with `bun run test tests/ui-theme.test.ts tests/ui-manage-page.test.ts tests/email-render.test.ts tests/providers-email.test.ts tests/ui-page-snapshots.test.ts tests/email-render-snapshot.test.ts`, and confirm the snapshot files are unchanged.

### Not in the batch (need a follow-up decision)
- `component/instance-ids:21` D and e2e `meeting-points:21` C: both are sound, but they move the regression to a slower Playwright-only layer. Worth confirming the owner preference before deleting.
- ui-booking-widget `:20/:33/:43` C and `:86` C: depend on the repaired component assertions landing first.
- Every copy-literal F (ui-manage-page, customer-page-routes, booking-widget-catalog, admin-incidents, admin.spec).

---

## Suspected product bugs / follow-ups

1. **Untested money conversion:** the operator partial refund, typed in major units, becomes `refundAmountMinor` via
   `Math.round(major * minorUnitFactor(currency))` (`src/routes/booking/manage.ts:130`). The e2e named for
   it (`operator.spec:36`) never observes the amount, and no unit or component test covers the
   conversion. No bug reproduced. It is a proof gap on a payment path.
2. **Vacuous negatives since 295ae19:** `email-render:45/55` would not notice the override failing to
   replace the default refund-timing sentence. That is a test defect, not a product one.
3. **Stale rationale:** `maze-pickup-options.spec.ts:178-180` still calls `meeting-points.spec` "the
   legacy pair". The smoke `oldTown` now declares `pickupOptions`.
4. **Brevo `fetchImpl` alias:** it is still accepted on `BrevoEmailProviderOptions` (`email-brevo/index.ts:32/92`), while
   MIGRATING-v2 retired `fetchImpl` for the Google provider. The only in-repo caller is a test. This is a public API
   inconsistency; decide on deprecation with a changeset.
5. **Enhancer behavior:** `ui-theme:99-127` are the only guard for admin enhancer tab/row/day-card
   behavior (architecture "Enhancer DOM test harness", deferred). Nothing was removed there.
