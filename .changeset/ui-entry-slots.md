---
"@reservajs/astro": minor
---

`@reservajs/astro/ui` now re-exports the presentation formatters (`formatDateTime`, `formatDayDate`, `formatDateParts`, `formatPrice`, `googleCalendarUrl`, `icsDataUrl`) alongside the message catalog, so an embed formats dates and prices exactly like Reserva's own pages. `formatDayDate(dateKey, locale, now?)` adds the year when the date falls in another year. Availability slots gain business-local `date` (`YYYY-MM-DD`) and `time` (`HH:MM`) next to `start`, and the `quantity` query parameter is now optional (defaults to 1). Calendar helpers `openDays`, `firstOpenDay`, `isDayDisallowed`, `dateKey` and `horizonRange` ship from `@reservajs/astro/client`.
