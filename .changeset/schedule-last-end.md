---
"@reservajs/astro": minor
---

Schedule rules can declare `lastEnd` (the time the last booking must be finished by) instead of `lastStart`, so a service stops subtracting `durationMin` by hand. Exactly one of the two per rule; a rule with neither keeps the `'18:00'` default. The last departure is derived as the latest start on the interval grid that still fits the duration, and `ResolvedScheduleRule` always carries the computed `lastStart`, so slot generation and occupancy are unchanged. A `lastEnd` that leaves no room for a booking starting at `firstStart` fails validation — including on an admin Hours save that pushes the first departure past it. The admin settings page shows a derived last departure read-only, with a hint naming the closing time it comes from.
