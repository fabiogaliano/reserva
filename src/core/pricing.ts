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

// Plan 018 (design decision 3): widened from the fixed { default, custom } shape — the key set is
// now whatever pickup ids a tour's own pricing rows declare (derived in resolvedPriceTableFor/
// pricingCombinations below), not a hard-coded pair.
export type ResolvedPriceTable = Record<string, number[]>;

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
  // Plan 018 (design decision 3): the key set is derived from the distinct pickup values the
  // pricing rows themselves declare, not a fixed pair — a tour-declared option with no pricing
  // rows (a config bug elsewhere) simply produces no column here instead of an empty array under
  // a hard-coded key.
  const pickupIds = Array.from(new Set(canonicalPricing.map((row) => row.pickup)));
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
  // Plan 018 (design decision 3): same key-set derivation as resolvedPriceTableFor above.
  const pickupIds = Array.from(new Set(tour.pricing.map((row) => row.pickup)));
  const result: Array<{ people: number; pickup: PickupType; priceCents: number }> = [];
  for (let people = 1; people <= highest; people += 1) {
    for (const pickup of pickupIds) {
      result.push({ people, pickup, priceCents: priceFor(tour, people, pickup) });
    }
  }
  return result;
}
