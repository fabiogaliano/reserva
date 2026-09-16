import type { PricingRule, ResolvedClientConfig, PickupType, ResolvedServiceConfig } from './config.js';
import { resolveService } from './config.js';

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

// The key set is whatever pickup ids a service's own pricing rows declare, or the single '' key
// for a location-less (tiers-only) service — not a hard-coded pair.
export type ResolvedPriceTable = Record<string, number[]>;

export function priceFor(service: Pick<ResolvedServiceConfig, 'pricing'>, quantity: number, pickup: PickupType | null): number {
  if (!Number.isInteger(quantity) || quantity < 1) throw new PricingError(quantity, pickup);
  // The tightest covering tier wins regardless of array order: validateConfig sorts its own output,
  // but this is exported and a raw config module (or a hand-built rule list) is a legitimate input,
  // where first-match would silently charge a wider tier. Normalizing an undefined `pickup` to null
  // lets a location-less lookup match it.
  let tightest: PricingRule | undefined;
  for (const candidate of service.pricing) {
    if ((candidate.pickup ?? null) !== pickup || quantity > candidate.maxQuantity) continue;
    if (!tightest || candidate.maxQuantity < tightest.maxQuantity) tightest = candidate;
  }
  if (!tightest) throw new PricingError(quantity, pickup);
  return tightest.priceMinor;
}

export function resolvedPriceTableFor(service: Pick<ResolvedServiceConfig, 'pricing'>): ResolvedPriceTable {
  const highest = Math.max(...service.pricing.map((row) => row.maxQuantity), 0);
  // The key set is each row's own `pickup` (or '' for a location-less row), in first-occurrence
  // order — not a fixed 'default'/'custom' pinning.
  const keys = Array.from(new Set(service.pricing.map((row) => row.pickup ?? '')));
  const table: ResolvedPriceTable = {};
  for (const key of keys) table[key] = [];
  for (let quantity = 1; quantity <= highest; quantity += 1) {
    for (const key of keys) {
      table[key]![quantity] = priceFor(service, quantity, key === '' ? null : key);
    }
  }
  return table;
}

export function priceForService(config: ResolvedClientConfig, serviceSlug: string, quantity: number, pickup: PickupType | null): number {
  return priceFor(resolveService(config, serviceSlug), quantity, pickup);
}

export function pricingCombinations(service: ResolvedServiceConfig): Array<{ quantity: number; pickup: PickupType | null; priceMinor: number }> {
  const highest = Math.max(...service.pricing.map((row) => row.maxQuantity), 0);
  // Same key-set derivation and ordering as resolvedPriceTableFor.
  const keys = Array.from(new Set(service.pricing.map((row) => row.pickup ?? '')));
  const result: Array<{ quantity: number; pickup: PickupType | null; priceMinor: number }> = [];
  for (let quantity = 1; quantity <= highest; quantity += 1) {
    for (const key of keys) {
      const pickup = key === '' ? null : key;
      result.push({ quantity, pickup, priceMinor: priceFor(service, quantity, pickup) });
    }
  }
  return result;
}
