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

export function priceFor(tour: TourConfig, people: number, pickup: PickupType): number {
  if (!Number.isInteger(people) || people < 1) throw new PricingError(people, pickup);
  const rule = tour.pricing.find((candidate) => candidate.pickup === pickup && people <= candidate.maxPeople);
  if (!rule) throw new PricingError(people, pickup);
  return rule.priceCents;
}

export function priceForTour(config: ClientConfig, tourSlug: string, people: number, pickup: PickupType): number {
  return priceFor(resolveTour(config, tourSlug), people, pickup);
}

export const resolvePrice = priceFor;
export const getPrice = priceFor;

export function pricingCombinations(tour: TourConfig): Array<{ people: number; pickup: PickupType; priceCents: number }> {
  const highest = Math.max(...tour.pricing.map((row) => row.maxPeople), 0);
  const result: Array<{ people: number; pickup: PickupType; priceCents: number }> = [];
  for (let people = 1; people <= highest; people += 1) {
    for (const pickup of ['default', 'custom'] as const) {
      result.push({ people, pickup, priceCents: priceFor(tour, people, pickup) });
    }
  }
  return result;
}
