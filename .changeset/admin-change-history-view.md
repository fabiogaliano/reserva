---
'@reservajs/astro': minor
---

The admin settings page has a **Recent changes** section listing the latest 20 changes made from the admin to settings, single-day capacity and scheduled capacity changes, newest first: when (in the business timezone), who made it (or "Unknown" when the admin sign-in exposes no identity), and what changed. It is read only when that section is opened. Sites that translate the admin into a locale other than en or pt-PT should add `admin.sectionHistory`, `admin.historyHint`, `admin.historyEmpty`, `admin.historyWhen`, `admin.historyWho`, `admin.historyWhat`, `admin.historyUnknownActor`, `admin.historySettingSet`, `admin.historySettingReset`, `admin.historyDaySet`, `admin.historyDayClosed`, `admin.historyDayCleared`, `admin.historyDefaultSet` and `admin.historyDefaultRemoved`.
