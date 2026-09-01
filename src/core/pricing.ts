import type { ClientConfig, PickupType, ServiceConfig } from './config';
import { resolveService } from './config';

export class PricingError extends Error {
  readonly quantity: number;
  // Plan 022: null is the location-less booking (no pickup axis at all). It reaches here exactly
  // like an undeclared id does — no rule matches — until plan 023 gives such a service its own
  // pricing shape.
  readonly pickup: PickupType | null;

  constructor(quantity: number, pickup: PickupType | null) {
    super(`No price configured for quantity=${quantity}, pickup=${pickup}`);
    this.name = 'PricingError';
    this.quantity = quantity;
    this.pickup = pickup;
  }
}

// The key set is whatever pickup ids a service's own pricing rows declare (derived in
// resolvedPriceTableFor/pricingCombinations below), not a hard-coded pair.
export type ResolvedPriceTable = Record<string, number[]>;

// The distinct pickup ids of a service's pricing rows, with 'default'/'custom' pinned first in that
// order and any other id following in first-occurrence order. The pinning is a byte-identity
// constraint, not cosmetics: the pre-018 table always serialized { default, custom } in that fixed
// order, and the widget embeds JSON.stringify of this table (insertion-ordered) in its markup — a
// legacy config whose raw pricing array happens to list custom rows first must still render the
// exact pre-018 bytes.
function pickupIdsFor(pricing: ServiceConfig['pricing']): string[] {
  const declared = Array.from(new Set(pricing.map((row) => row.pickup)));
  return [
    ...(['default', 'custom'] as const).filter((id) => declared.includes(id)),
    ...declared.filter((id) => id !== 'default' && id !== 'custom'),
  ];
}

export function priceFor(service: Pick<ServiceConfig, 'pricing'>, quantity: number, pickup: PickupType | null): number {
  if (!Number.isInteger(quantity) || quantity < 1) throw new PricingError(quantity, pickup);
  // Config validation orders each pickup's rules by maxQuantity, so the first fit is the tightest tier.
  const rule = service.pricing.find((candidate) => candidate.pickup === pickup && quantity <= candidate.maxQuantity);
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
  // Plan 018 (design decision 3): the key set comes from the pricing rows themselves, not a fixed
  // pair — a service-declared option with no pricing rows (a config bug elsewhere) simply produces no
  // column here instead of an empty array under a hard-coded key.
  const pickupIds = pickupIdsFor(service.pricing);
  const table: ResolvedPriceTable = {};
  for (const pickup of pickupIds) table[pickup] = [];
  for (let quantity = 1; quantity <= highest; quantity += 1) {
    for (const pickup of pickupIds) {
      table[pickup]![quantity] = priceFor({ pricing: canonicalPricing }, quantity, pickup);
    }
  }
  return table;
}

export function priceForService(config: ClientConfig, serviceSlug: string, quantity: number, pickup: PickupType | null): number {
  return priceFor(resolveService(config, serviceSlug), quantity, pickup);
}

export const resolvePrice = priceFor;
export const getPrice = priceFor;

export function pricingCombinations(service: ServiceConfig): Array<{ quantity: number; pickup: PickupType; priceMinor: number }> {
  const highest = Math.max(...service.pricing.map((row) => row.maxQuantity), 0);
  // Plan 018 (design decision 3): same key-set derivation and ordering as resolvedPriceTableFor.
  const pickupIds = pickupIdsFor(service.pricing);
  const result: Array<{ quantity: number; pickup: PickupType; priceMinor: number }> = [];
  for (let quantity = 1; quantity <= highest; quantity += 1) {
    for (const pickup of pickupIds) {
      result.push({ quantity, pickup, priceMinor: priceFor(service, quantity, pickup) });
    }
  }
  return result;
}
