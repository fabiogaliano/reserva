import type { ResolvedClientConfig, PickupType, SurchargeScope } from './config.js';
import { maxQuantityFor, resolveService } from './config.js';

export class PricingError extends Error {
  readonly quantity: number;
  // null means either a location-less booking, or a location-ful lookup for the implicit '' key.
  readonly pickup: PickupType | null;

  constructor(quantity: number, pickup: PickupType | null) {
    super(`No price configured for quantity=${quantity}, pickup=${pickup}`);
    this.name = 'PricingError';
    this.quantity = quantity;
    this.pickup = pickup;
  }
}

// The key set is whatever pickup ids a service's own pricing declares, or the single '' key for a
// location-less (tiers-only) service — not a hard-coded pair.
export type ResolvedPriceTable = Record<string, number[]>;

// Accepts both the resolved config's rows (`pickup?: string`) and the catalog's (`pickup: string | null`),
// so a funnel can pass `catalog.services[i]` straight in.
export interface PricingRow {
  maxQuantity: number;
  pickup?: string | null | undefined;
  priceMinor: number;
}

// The resolved formula, as the config and the catalog both publish it: every inherited field is
// already materialized, so a price needs nothing beyond the service itself.
export interface PricingFormula {
  baseMinor: number;
  surcharges: Record<string, number>;
  maxUnits: number;
  surchargeScope: SurchargeScope;
  seatsPerUnit: number;
}

export interface Priceable {
  pricing: ReadonlyArray<PricingRow> | PricingFormula;
}

export function isPricingFormula(pricing: Priceable['pricing']): pricing is PricingFormula {
  return !Array.isArray(pricing);
}

// How many capacity units a party of `quantity` takes under formula pricing.
export function unitsFor(formula: { seatsPerUnit: number }, quantity: number): number {
  return Math.ceil(quantity / formula.seatsPerUnit);
}

// The pickup keys a service prices, in the order a price table lists them: `null` is the single
// location-less column. Shared by the table builders and the availability handler's probe.
export function pricingPickupKeys(service: Priceable): Array<PickupType | null> {
  if (isPricingFormula(service.pricing)) {
    const ids = Object.keys(service.pricing.surcharges);
    return ids.length === 0 ? [null] : ids;
  }
  // Each row's own `pickup` (or null for a location-less row), in first-occurrence order.
  const keys = new Set(service.pricing.map((row) => row.pickup ?? null));
  return Array.from(keys);
}

function formulaPrice(formula: PricingFormula, quantity: number, pickup: PickupType | null): number {
  const units = unitsFor(formula, quantity);
  if (units > formula.maxUnits) throw new PricingError(quantity, pickup);
  const ids = Object.keys(formula.surcharges);
  let surcharge = 0;
  if (ids.length === 0) {
    if (pickup !== null) throw new PricingError(quantity, pickup);
  } else {
    if (pickup === null) throw new PricingError(quantity, pickup);
    const amount = formula.surcharges[pickup];
    if (amount === undefined) throw new PricingError(quantity, pickup);
    surcharge = amount;
  }
  return formula.baseMinor * units + surcharge * (formula.surchargeScope === 'unit' ? units : 1);
}

export function priceFor(service: Priceable, quantity: number, pickup: PickupType | null): number {
  if (!Number.isInteger(quantity) || quantity < 1) throw new PricingError(quantity, pickup);
  if (isPricingFormula(service.pricing)) return formulaPrice(service.pricing, quantity, pickup);
  // The tightest covering tier wins regardless of array order: validateConfig sorts its own output,
  // but this is exported and a raw config module (or a hand-built rule list) is a legitimate input,
  // where first-match would silently charge a wider tier. Normalizing an undefined `pickup` to null
  // lets a location-less lookup match it.
  let tightest: PricingRow | undefined;
  for (const candidate of service.pricing) {
    if ((candidate.pickup ?? null) !== pickup || quantity > candidate.maxQuantity) continue;
    if (!tightest || candidate.maxQuantity < tightest.maxQuantity) tightest = candidate;
  }
  if (!tightest) throw new PricingError(quantity, pickup);
  return tightest.priceMinor;
}

export function resolvedPriceTableFor(service: Priceable): ResolvedPriceTable {
  const highest = maxQuantityFor(service);
  const keys = pricingPickupKeys(service);
  const table: ResolvedPriceTable = {};
  for (const key of keys) table[key ?? ''] = [];
  for (let quantity = 1; quantity <= highest; quantity += 1) {
    for (const key of keys) {
      table[key ?? '']![quantity] = priceFor(service, quantity, key);
    }
  }
  return table;
}

export function priceForService(config: ResolvedClientConfig, serviceSlug: string, quantity: number, pickup: PickupType | null): number {
  return priceFor(resolveService(config, serviceSlug), quantity, pickup);
}

export function pricingCombinations(service: Priceable): Array<{ quantity: number; pickup: PickupType | null; priceMinor: number }> {
  const highest = maxQuantityFor(service);
  const keys = pricingPickupKeys(service);
  const result: Array<{ quantity: number; pickup: PickupType | null; priceMinor: number }> = [];
  for (let quantity = 1; quantity <= highest; quantity += 1) {
    for (const pickup of keys) {
      result.push({ quantity, pickup, priceMinor: priceFor(service, quantity, pickup) });
    }
  }
  return result;
}

// The "from €X" figure: the lowest amount any party size and pickup can be charged.
export function lowestPriceMinor(service: Priceable): number {
  return Math.min(...pricingCombinations(service).map((cell) => cell.priceMinor));
}
