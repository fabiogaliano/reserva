---
---

Drop two internal functions whose only callers were tests: the catalog projection helper loses its export (its test now drives the catalog handler) and occupancy's unused `remainingCapacity` is removed. Neither is reachable from a package entry point; behavior is unchanged.
