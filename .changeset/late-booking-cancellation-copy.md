---
'@reservajs/astro': patch
---

Confirmation emails for a booking made inside the cancellation cutoff no longer promise a free-cancellation date that had already passed; the Cancellation row now says free cancellation is not available (new copy key `cancellation.closed`, overridable per locale).
