---
'@reservajs/astro': patch
---

Payment verification and the confirmation page now use the currency stored on the booking, so a checkout started before a `business.currency` change is no longer rejected as a currency mismatch or shown in the new currency.
