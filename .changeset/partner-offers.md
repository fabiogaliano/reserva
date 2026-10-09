---
'@reservajs/astro': minor
---

Partners and their offers are managed in the admin (`?view=partners`) and stored in D1 by migration 0009. A visitor's referral code resolves through `POST /api/booking/referral` (`client.resolveReferral()`), one code at a time, so no partner list is published. Quotes take an optional `referralCode` and return a price breakdown and a `quoteFingerprint`; a checkout with a `referralCode` must send the fingerprint it reviewed, and gets `409 quote_changed` with the new quote when the price or benefits moved. An accepted checkout stores its attribution and amounts on the booking, and later edits cannot change them.

Benefits apply only when the runtime `partnerOffers` policy is enabled and names a minimum charge for the currency. Without the policy nothing changes for existing callers.
