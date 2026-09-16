---
"@reservajs/astro": patch
---

`validation_failed` responses now name the field and can carry structured details. `ApiErrorEnvelope.error` gains an optional `details: { field?, allowed? }` (`ApiErrorDetails`), populated by the unknown-service, pricing, date-range, pickup, meeting-point and metadata `select` rejections; `HttpError` takes an optional `details` argument. Five messages were rewritten to start with the offending field. Cancelling a booking that a concurrent reschedule moved now answers `409 invalid_transition` ("booking was rescheduled; reload and try again") instead of `slot_unavailable`.
