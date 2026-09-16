---
"@reservajs/astro": minor
---

Close the response contract gaps: payment and change deadlines, and a post-grace status summary.

`CheckoutResponse.paymentDeadline` reports when the payment page closes (the provider's own
`expiresAt`, falling back to the hold expiry). `ManageResponse` gains `cancelDeadline` and
`rescheduleDeadline` as separate policies; `deadline` stays as an alias of `cancelDeadline` for one
minor. Past the four-hour detail grace, `GET /api/booking/status` answers `confirmed` with a
`ConfirmationSummary` (`reference`, `serviceTitle`, `start`, `end`, `locale`) instead of `null`, and
the confirmation page renders that summary with the "details were emailed" copy. `QuoteRequest.locale`
is removed from the type; the handler still accepts and silently ignores the key.
