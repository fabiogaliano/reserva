import type { ClientConfig, PickupType, ServiceConfig } from './config';
import { resolveService } from './config';

export class PricingError extends Error {
  readonly quantity: number;
  // null is the location-less booking (no pickup axis at all) or a location-ful lookup for the
  // implicit '' table key — see priceFor below.
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

export function priceFor(service: Pick<ServiceConfig, 'pricing'>, quantity: number, pickup: PickupType | null): number {
  if (!Number.isInteger(quantity) || quantity < 1) throw new PricingError(quantity, pickup);
  // Config validation orders each pickup's rules by maxQuantity, so the first fit is the tightest
  // tier. A location-less rule's `pickup` is undefined; normalizing it to null here is what lets a
  // location-less lookup (pickup: null) match it — see core/config.ts validateService, which
  // guarantees the two never mix within one service.
  const rule = service.pricing.find((candidate) => (candidate.pickup ?? null) === pickup && quantity <= candidate.maxQuantity);
  if (!rule) throw new PricingError(quantity, pickup);
  return rule.priceMinor;
}

export function resolvedPriceTableFor(service: Pick<ServiceConfig, 'pricing'>): ResolvedPriceTable {
  // This is what builds the widget's price lookup table, and its `pricing` argument travels
  // however the embedding page sourced it — typically the consumer's own raw config module, not
  // validateConfig's canonical return (see examples/smoke-site: config.ts is imported directly by
  // pages, independently of runtime.ts's validateConfig call). Sorting a local copy here — rather
  // than trusting priceFor's sortedness invariant on the array we were handed — makes this table
  // match the tightest-fitting-tier semantics by construction, regardless of input order, so it
  // can never silently diverge from the server's canonicalized resolution.
  const canonicalPricing = [...service.pricing].sort((a, b) => a.maxQuantity - b.maxQuantity);
  const highest = Math.max(...canonicalPricing.map((row) => row.maxQuantity), 0);
  // Plan 023 (design decision 2): the key set is each row's own `pickup` (or '' for a
  // location-less row), in first-occurrence order — no more pinning 'default'/'custom' first, since
  // that existed only for byte-identity with the removed pre-018 widget markup.
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

export function priceForService(config: ClientConfig, serviceSlug: string, quantity: number, pickup: PickupType | null): number {
  return priceFor(resolveService(config, serviceSlug), quantity, pickup);
}

export const resolvePrice = priceFor;
export const getPrice = priceFor;

export function pricingCombinations(service: ServiceConfig): Array<{ quantity: number; pickup: PickupType | null; priceMinor: number }> {
  const highest = Math.max(...service.pricing.map((row) => row.maxQuantity), 0);
  // Plan 023 (design decision 2): same key-set derivation and ordering as resolvedPriceTableFor.
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
