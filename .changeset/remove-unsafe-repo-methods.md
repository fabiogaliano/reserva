---
'@reservajs/astro': minor
---

`ReservaContext.repo` no longer has `insertHold`, `upsertDayOverride`, `deleteDayOverride` or `upsertSetting`. Each wrote around a guard Reserva relies on: `insertHold` skipped the slot capacity check, and the other three left no entry in the admin's Recent changes. Use `insertHoldWithCapacity`, `upsertDayOverrides([date], …, audit)`, `deleteDayOverrides([date], audit)` and `applySettingsBatch([{ type: 'upsert', key, value }], audit)` instead.

`brevoEmail()` no longer accepts `fetchImpl`; pass `fetch`, the same option `GoogleCalendarProvider` has used since 0.5.0.

See "Migrating to 0.15.0" in docs/MIGRATING-v2.md.
