---
'@reservajs/astro': minor
---

The field names deprecated in 0.5.0 are no longer read: use `serviceSlug` instead of `?service=` on availability, `sessionId` instead of `?session_id=` on status and the confirmation page, `pickup` instead of `pickupType` in the checkout body, and `start` instead of `newStart` in the reschedule body. A request still using an old name now gets `400 validation_failed` naming the field it's missing. `ManageResponse.deadline` is gone; read `cancelDeadline`. The typed client already sends the current names, so it needs no change. The `deprecated field` log line is gone too.
