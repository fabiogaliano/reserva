---
'@reservajs/astro': minor
---

A deployment without a calendar provider no longer records a calendar delivery for every confirmed booking. The record was claimed and marked delivered without any call, which cost D1 queries on every payment: confirming a booking with customer and owner emails and one durable hook now takes 27 instead of 32. A booking confirmed while no calendar is configured still gets no calendar event if one is configured later, as before.

`ReservaContext.repo.confirmWithSideEffectOperations` now requires `calendarEvent: 'owed' | 'not_owed'`, and `ensureConfirmationSideEffectOperations` takes it as its fourth argument, before `eventSeeds` and `emailRecipients`. Pass `'owed'` only when a calendar provider is configured. A custom `repo` implementation should insert its `calendar_create` row only for `'owed'`.
