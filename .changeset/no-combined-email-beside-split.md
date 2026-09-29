---
'@reservajs/astro': patch
---

After switching to an email provider without `sendToRecipient`, a booking already confirmed with per-recipient emails no longer gets an extra combined confirmation email, which re-sent the customer's copy.
