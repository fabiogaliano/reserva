---
---

Drop unused internal surface: the route manifest's unimported entry/option types and enablement predicate lose their exports, occupancy loses its unused `resolveService` option alias, and the test-only `expireBooking` helper is removed. None is reachable from a package entry point; behavior is unchanged.
