---
'@reservajs/astro': patch
---

The reconciliation sweep's query budget now counts the two queries a calendar delete spends clearing the event from the booking when a pending refund cancels it. Left uncounted, they came out of the queries kept back for the operator alert, so on that tick the alert could wait for the next one.
