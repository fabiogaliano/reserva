import type { ClientConfig, PickupType, TourConfig } from './config';
import { resolveTour } from './config';

export class PricingError extends Error {
  readonly people: number;
  readonly pickup: PickupType;

  constructor(people: number, pickup: PickupType) {
    super(`No price configured for people=${people}, pickup=${pickup}`);
    this.name = 'PricingError';
    this.people = people;
    this.pickup = pickup;
  }
}

// The key set is whatever pickup ids a tour's own pricing rows declare (derived in
// resolvedPriceTableFor/pricingCombinations below), not a hard-coded pair.
export type ResolvedPriceTable = Record<string, number[]>;

// The distinct pickup ids of a tour's pricing rows, with 'default'/'custom' pinned first in that
// order and any other id following in first-occurrence order. The pinning is a byte-identity
// constraint, not cosmetics: the pre-018 table always serialized { default, custom } in that fixed
// order, and the widget embeds JSON.stringify of this table (insertion-ordered) in its markup — a
// legacy config whose raw pricing array happens to list custom rows first must still render the
// exact pre-018 bytes.
function pickupIdsFor(pricing: TourConfig['pricing']): string[] {
  const declared = Array.from(new Set(pricing.map((row) => row.pickup)));
  return [
    ...(['default', 'custom'] as const).filter((id) => declared.includes(id)),
    ...declared.filter((id) => id !== 'default' && id !== 'custom'),
  ];
}

export function priceFor(tour: Pick<TourConfig, 'pricing'>, people: number, pickup: PickupType): number {
  if (!Number.isInteger(people) || people < 1) throw new PricingError(people, pickup);
  // Config validation orders each pickup's rules by maxPeople, so the first fit is the tightest tier.
  const rule = tour.pricing.find((candidate) => candidate.pickup === pickup && people <= candidate.maxPeople);
  if (!rule) throw new PricingError(people, pickup);
  return rule.priceCents;
}

export function resolvedPriceTableFor(tour: Pick<TourConfig, 'pricing'>): ResolvedPriceTable {
  // This is what builds the widget's price lookup table, and its `pricing` argument travels
  // however the embedding page sourced it — typically the consumer's own raw config module, not
  // validateConfig's canonical return (see examples/smoke-site: config.ts is imported directly by
  // pages, independently of runtime.ts's validateConfig call). Sorting a local copy here — rather
  // than trusting priceFor's sortedness invariant on the array we were handed — makes this table
  // match the tightest-fitting-tier semantics by construction, regardless of input order, so it
  // can never silently diverge from the server's canonicalized resolution.
  const canonicalPricing = [...tour.pricing].sort((a, b) => a.maxPeople - b.maxPeople);
  const highest = Math.max(...canonicalPricing.map((row) => row.maxPeople), 0);
  // Plan 018 (design decision 3): the key set comes from the pricing rows themselves, not a fixed
  // pair — a tour-declared option with no pricing rows (a config bug elsewhere) simply produces no
  // column here instead of an empty array under a hard-coded key.
  const pickupIds = pickupIdsFor(tour.pricing);
  const table: ResolvedPriceTable = {};
  for (const pickup of pickupIds) table[pickup] = [];
  for (let people = 1; people <= highest; people += 1) {
    for (const pickup of pickupIds) {
      table[pickup]![people] = priceFor({ pricing: canonicalPricing }, people, pickup);
    }
  }
  return table;
}

export function priceForTour(config: ClientConfig, tourSlug: string, people: number, pickup: PickupType): number {
  return priceFor(resolveTour(config, tourSlug), people, pickup);
}

export const resolvePrice = priceFor;
export const getPrice = priceFor;

export function pricingCombinations(tour: TourConfig): Array<{ people: number; pickup: PickupType; priceCents: number }> {
  const highest = Math.max(...tour.pricing.map((row) => row.maxPeople), 0);
  // Plan 018 (design decision 3): same key-set derivation and ordering as resolvedPriceTableFor.
  const pickupIds = pickupIdsFor(tour.pricing);
  const result: Array<{ people: number; pickup: PickupType; priceCents: number }> = [];
  for (let people = 1; people <= highest; people += 1) {
    for (const pickup of pickupIds) {
      result.push({ people, pickup, priceCents: priceFor(tour, people, pickup) });
    }
  }
  return result;
}
