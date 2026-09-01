# Example configs

Complete `ClientConfig` files for different business shapes. Each one typechecks and passes
`validateConfig()`; copy the closest match and adapt it.

- [`tour-operator.ts`](./tour-operator.ts) — tours with meeting points and per-pickup-option
  pricing, including the non-additive four-option case.
- [`restaurant.ts`](./restaurant.ts) — deposit-backed reservations, no location module,
  declared metadata fields (dietary notes, occasion, high chair).
- [`fitness-studio.ts`](./fitness-studio.ts) — group classes, per-person prices as quantity
  breakpoints. The minimal shape.

For a config that exercises every optional module at once, see
[`../smoke-site/src/config.ts`](../smoke-site/src/config.ts).
