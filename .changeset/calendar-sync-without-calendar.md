---
'@reservajs/astro': minor
---

Cancelling or rescheduling a booking whose calendar event was made while a calendar was configured no longer records a calendar delete or update once the calendar is gone. Nothing could run those records, so they stayed owed forever, and the reconciliation sweep, which takes the oldest owed records 10 at a time, stopped retrying anything else once 10 of them had piled up. The sweep now also leaves out records whose provider is not configured, so ones already waiting, or left behind when an email provider is removed, no longer block it. They still wait for the provider to come back. The event itself stays as it was in the calendar the deployment no longer writes to.

`ReservaContext.repo.listSideEffectExecutionCandidates` takes a fourth argument, the providers that are not configured (`'calendar'`, `'email'`). A custom `repo` implementation should leave out the records only those providers can run.
