---
"@reservajs/astro": minor
---

Business-wide opening hours and formula pricing, so a fleet operator states its day and its
pick-up surcharge once instead of once per service.

- `hours` at the top level is inherited by every service that declares no `schedule`; each
  service still derives its own last departure from a shared `lastEnd`.
- A service's `pricing` may now be a formula `{ baseMinor, surcharges?, maxUnits?, surchargeScope? }`:
  `baseMinor` per capacity unit (`occupancy.seatsPerUnit` seats), times the units the party
  needs, plus the chosen pickup option's surcharge, per unit or per booking. Undeclared fields
  inherit the top-level `pricing: { surcharges, maxUnits, surchargeScope }` block. Breakpoint rows
  are unchanged and remain the way to express a non-linear price curve.
- The admin Hours tab edits the shared block as one statement, closing time included; the Pricing
  tab edits the shared surcharges, group size, and one base price per formula service. Values a
  service declares for itself sit under a folded "Service-specific overrides" disclosure.
- **Breaking:** the catalog's `pricing` is now `CatalogPricingRule[] | CatalogPricingFormula`, and
  every service also publishes `maxQuantity`. `priceFor`, `resolvedPriceTableFor` and
  `pricingCombinations` accept both shapes; `lowestPriceMinor`, `maxQuantityFor`,
  `isPricingFormula` and `unitsFor` are new on `@reservajs/astro/core`. Stored admin override rows
  that no longer match a setting are dropped with a load warning. See `docs/MIGRATING-v2.md`.
