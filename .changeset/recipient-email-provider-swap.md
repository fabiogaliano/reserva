---
'@reservajs/astro': patch
---

A cancellation, reschedule, no-show or reminder email owed to one recipient (customer or owner) is now abandoned, with an operator log and an incident, when the email provider has been swapped for one that cannot send to a single recipient. Before, it stayed owed forever, and ten of them stopped the reconciliation sweep from retrying anything else. Confirmation emails already worked this way. Once a provider that can send to one recipient is back, "Try again" in the admin sends it.
