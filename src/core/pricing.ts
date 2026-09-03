import type { ResolvedClientConfig, PickupType, ResolvedServiceConfig } from './config.js';
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
  // Config validation orders each pickup's rules by maxQuantity, so the first fit is the tightest
  // tier. Normalizing an undefined `pickup` to null lets a location-less lookup match it.
  const rule = service.pricing.find((candidate) => (candidate.pickup ?? null) === pickup && quantity <= candidate.maxQuantity);
  if (!rule) throw new PricingError(quantity, pickup);
  return rule.priceMinor;
}

export function resolvedPriceTableFor(service: Pick<ResolvedServiceConfig, 'pricing'>): ResolvedPriceTable {
  // `pricing` may arrive unsorted (e.g. a raw config module, not validateConfig's canonical
  // return), so this sorts a local copy rather than trusting the array's order — the table always
  // matches tightest-fitting-tier semantics, regardless of input order.
  const canonicalPricing = [...service.pricing].sort((a, b) => a.maxQuantity - b.maxQuantity);
  const highest = Math.max(...canonicalPricing.map((row) => row.maxQuantity), 0);
  // The key set is each row's own `pickup` (or '' for a location-less row), in first-occurrence
  // order — not a fixed 'default'/'custom' pinning.
  const keys = Array.from(new Set(canonicalPricing.map((row) => row.pickup ?? '')));
  const table: ResolvedPriceTable = {};
  for (const key of keys) table[key] = [];
  for (let quantity = 1; quantity <= highest; quantity += 1) {
    for (const key of keys) {
      table[key]![quantity] = priceFor({ pricing: canonicalPricing }, quantity, key === '' ? null : key);
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
