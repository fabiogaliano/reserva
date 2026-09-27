# UI bug triage — 2026-09-27

Every item below was reviewed with the owner and accepted for fixing, with the chosen approach.
Ordered by priority within each area.

## Admin — Upcoming list and filters (`src/handlers/admin.ts`, `src/repo.ts`, `src/ui/pages/admin-page.ts`)

1. **Use one query for the list.** Today "All" reads `listUpcoming` (confirmed + live holds, now→+90d) while any search or status reads `listAllFrom` (all statuses, from −1y with no end), so "Confirmed" can show more rows than "All". Replace both with a single query: status is a SQL predicate, and the time window is a separate control (Upcoming / Past). "All" = every status within the window.
2. **Real paging** instead of the silent 500-row cap. Upcoming sorts ascending; Past sorts descending. Show "showing X of Y".
3. **Upcoming starts at 00:00 today in the business timezone**, not at `now`, so trips already in progress stay visible (needed for marking no-shows).
4. **Separate filter labels** from the row badges. pt-PT: Todas / Confirmadas / A aguardar pagamento / Expiradas / Canceladas / Não compareceram. Empty filtered state: "Nenhuma reserva corresponde aos filtros."
   - The rework also fixes `until` being dropped by the filter form, tabs, day links and "Clear filters"; the rolling-UTC window edge; and "Show later bookings" appearing where it does nothing.

## Admin — availability and settings

5. **The calendar gets its own count query** covering the whole `maxHorizonDays`, independent of the list's window and row cap.
6. **Day cell shows peak concurrent units against capacity**, plus the trip count (`2/2 peak · 6 trips`), instead of a daily sum compared with capacity.
7. **Blank capacity is rejected** on `set` and `default-set`, with `required` on the input. Only Close means 0.
8. **Enter on the settings page saves.** Put a hidden default Save button first in each form, so the per-field Reset buttons are never the default.
9. **Resets run the same combined validation as Save** (`mergeAndValidateSettings`) and refuse invalid combinations, naming the conflicting field.
10. **Normalize `days`** (sort + dedupe) in the config schema, so equal sets compare equal.
11. **Admin POST failures redirect back** with `?error=<code>` and a readable alert, instead of raw JSON. An expired CSRF token gets a "page expired, retry" message.
12. **Hide Retry** for incidents of type oversell, payment_verification and reconciliation.
13. Minor fixes:
    - Actually hide the "To" date field once JS is active.
    - Keep one Tab stop in the calendar, with arrow-key navigation.
    - The day-title `<h2>` keeps its heading role, with a separate live region for announcements.
    - The attention count is a real COUNT, not capped at 100.

## Confirmation page (`src/routes/booking-confirmation.ts`, `src/ui/pages/confirmation-page.ts`)

14. **A 5xx from status is treated as pending**: keep refreshing within the 20-attempt limit, then show the "still waiting" page. Never show "not found" for a server error.
15. **Locale:**
    - The Stripe success URL carries `&locale=`.
    - `?locale` resolves through requested → base language → default; `lang` uses the resolved locale.
16. **ICS:** `UID = <bookingId>@<business host>` (stable across reschedules), and `DTSTAMP` = the time the file was generated. This also affects the email attachment.
17. **Pending page:** when JS runs, poll the status API and update a polite live region; keep the meta refresh as the no-JS fallback. Add a skip link to the customer pages.

## Manage page (`src/routes/booking/manage.ts`, `src/ui/pages/manage-page.ts`, `src/ui/manage-enhancer.ts`)

18. **After a successful cancel**, render a cancelled confirmation (reference, refund note, Book again) from the POST, instead of redirecting to the revoked token. Keep the token revocation, and update the `tests/e2e/customer-manage.spec.ts` expectation.
19. **Availability accepts the manage token** and excludes that booking, so the reschedule calendar doesn't count the customer's own booking against capacity. Never accept a raw booking id.
20. **The reschedule range end** = `addDaysToDateKey(from, maxHorizonDays)`, which fixes the DST 400 error.
21. **A reschedule reports success once the DB commits.** A calendar-sync failure goes to the outbox/incident path.
22. **Pre-redirect validation errors** (partial refund with no amount, a DST-nonexistent local time) use the `?error=` redirect. Partial amount is required when "partial" is selected.
23. **Double submit:**
    - Disable submit buttons on submit.
    - The server treats "already at this start" as a successful no-op.
24. **Show both deadlines**, and explain when a single action has closed, with contact details.
25. Minor fixes:
    - `Object.hasOwn` for the `?error=` lookup.
    - Strip `done`/`error` from the URL after rendering.
    - Trim the trailing slash on the client `base`.
    - Docs warning: analytics in `headHtml` can report the manage token in `page_location`.

## Theme / CSS (`src/ui/tokens.css`, `src/ui/theme.ts`, `src/ui/branding.ts`, `src/ui/components.css`, asset routes)

26. **Reserva's token rules use `:where(…)`**, so a plain `:root` override wins in both schemes, matching the docs.
27. **`components.css` scopes tokens and color-scheme to `.bk-embed`**, never `:root`. The embed follows the host's `data-theme`.
28. **Focus:**
    - `outline: 2px solid transparent` instead of `none`, so focus is visible in forced-colors mode.
    - A solid accent ring with offset, ≥3:1.
29. **Branding `accentColor` gets an auto-derived lighter dark-mode variant**, reaching ≥4.5:1 on the dark surface.
30. More fixes:
    - Asset routes return `no-store` when `?v` ≠ the current hash.
    - Derive the focus ring from `var(--bk-accent)` where it's used.
    - Accent badge text contrast ≥4.5:1.
    - Light tokens in print.
31. Page fixes:
    - Show the end date for multi-day bookings.
    - Masthead list: margin and `--bk-masthead-muted`.
    - Reject unbalanced brackets in `fontFamily`.
    - Neutral copy on the 4h summary view.

## Example widget (`examples/smoke-site/src/components/BookingWidget.astro`, `booking-widget.css`)

32. **`.bkw-retry[hidden] { display: none }`**, plus an e2e assertion.
33. **Checkout in-flight flag** respected by `renderSlots`, plus a `pageshow` (persisted) reset.
34. **Party-size options from the catalog's `maxQuantity`**; the prop stays as an override.
35. **Errors:** map `cause.code` to localized copy.
36. **Render `metadataFields`**; the e2e tests fill them like a user would.
37. Minor fixes:
    - Pass the config to `resolveMessages`.
    - Define tokens on the demo pages.
    - `?service=` → `serviceSlug`.
    - Reword "Only {n} left".
