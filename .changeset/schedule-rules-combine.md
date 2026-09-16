---
"@reservajs/astro": patch
---

Schedule rules now combine instead of first-match. `generateSlots` generates from every rule matching the date (deduped on identical start, sorted ascending), so a split day (morning + evening rules) keeps both windows instead of silently dropping every rule after the first. `scheduleForDate` is replaced by `scheduleRulesForDate`, and config validation rejects two rules that share a weekday, overlap seasons and produce the same start time, naming both indices.
