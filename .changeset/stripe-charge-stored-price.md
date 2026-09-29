---
'@reservajs/stripe': patch
---

Stripe Checkout now charges the booking's stored price and currency instead of recomputing the price from config, so a pricing change after a hold was created can no longer produce a payment the webhook then rejects as mismatched.
