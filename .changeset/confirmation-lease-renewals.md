---
'@reservajs/astro': patch
---

A confirmation email or calendar event is no longer sent a second time when the provider call outlasts the five-minute confirmation lease and nothing else took the booking over in the meantime. The delivery is now recorded; before, it was refused and retried. Each confirmation email or calendar event also stopped renewing the lease three times: the claim and the record of the outcome already check that this caller still holds the lease. A payment webhook confirming a booking with customer and owner emails, a calendar event and one durable hook makes 9 fewer D1 queries, 32 instead of 41 (44 instead of 53 when it also runs the schema check), which keeps it under the Workers Free plan's 50 per invocation.
