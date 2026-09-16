---
"@reservajs/astro": minor
"@reservajs/stripe": minor
---

Provider options: one name per option, one export per class.

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
