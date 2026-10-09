import { isPricingFormula, priceFor, unitsFor, type Priceable } from './pricing.js';

/** Runtime-only policy; never included in the public catalog or build-time config. */
export interface PartnerOffersPolicy {
  readonly enabled: boolean;
  readonly minimumChargeMinorByCurrency: Readonly<Record<string, number>>;
  /** Explicit attribution-only bridge for an existing site's declared metadata field. */
  readonly legacyMetadataField?: string;
}

/** Operator attribution captured once at checkout; not a customer-facing partner label. */
export interface PartnerAttributionSnapshot {
  readonly code: string;
  readonly name: string;
  readonly revision: number;
}

/** One current offer; percentage applies to the service component, never the pickup. */
export interface PartnerOffer {
  readonly enabled: boolean;
  readonly basisPoints: number;
  readonly waivedPickupIds: readonly string[];
}

/** Immutable benefits captured by the server when a checkout is accepted. */
export interface AppliedPartnerOffer {
  readonly basisPoints: number;
  readonly waivedPickupId: string | null;
}

/** Customer-safe amounts, independent of operator attribution and current partner records. */
export interface OfferPricing {
  // Tier pricing has no trustworthy decomposition; null must not be presented as zero.
  readonly serviceSubtotalMinor: number | null;
  readonly pickupSubtotalMinor: number | null;
  readonly originalTotalMinor: number;
  readonly serviceDiscountMinor: number;
  readonly pickupDiscountMinor: number;
  readonly savingsMinor: number;
  readonly priceMinor: number;
  readonly appliedOffer: AppliedPartnerOffer | null;
}

/** An offer or price which cannot safely be sold. */
export class PartnerOfferError extends Error {
  readonly _tag = 'PartnerOfferError' as const;
  constructor(readonly reason: 'invalid_offer' | 'invalid_price' | 'unsupported_pricing' | 'payment_floor', message: string) {
    super(message);
  }
}

/** Explicit results keep unsupported prices distinct from an absent benefit. */
export type PartnerOfferResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PartnerOfferError };

function failure(reason: PartnerOfferError['reason'], message: string): PartnerOfferResult<never> {
  return { ok: false, error: new PartnerOfferError(reason, message) };
}

/** Parse a percentage without floating-point rounding; at most two decimal places are accepted. */
export function parseOfferPercentage(input: string): PartnerOfferResult<number> {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match?.[1]) return failure('invalid_offer', 'Percentage must be between 0 and 100 with at most two decimal places.');
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (basisPoints > 10_000) return failure('invalid_offer', 'Percentage must be between 0 and 100.');
  return { ok: true, value: basisPoints };
}

/** Parse an untrusted offer at the persistence/admin boundary, retaining disabled benefits. */
export function parsePartnerOffer(input: unknown): PartnerOfferResult<PartnerOffer> {
  if (!input || typeof input !== 'object' || !('enabled' in input) || !('basisPoints' in input) || !('waivedPickupIds' in input)) {
    return failure('invalid_offer', 'Offer must contain enabled, basisPoints and waivedPickupIds.');
  }
  const { enabled, basisPoints, waivedPickupIds } = input;
  if (typeof enabled !== 'boolean' || typeof basisPoints !== 'number' || !Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    return failure('invalid_offer', 'Offer percentage must be integer basis points between 0 and 10000.');
  }
  if (!Array.isArray(waivedPickupIds) || waivedPickupIds.length > 100) {
    return failure('invalid_offer', 'Pickup waivers must be an array of at most 100 IDs.');
  }
  const ids: string[] = [];
  for (const id of waivedPickupIds) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 100 || ids.includes(id)) {
      return failure('invalid_offer', 'Pickup waiver IDs must be unique nonempty strings of at most 100 characters.');
    }
    ids.push(id);
  }
  return { ok: true, value: { enabled, basisPoints, waivedPickupIds: ids } };
}

/** Whether a configured offer requests any monetary benefit, independently of its switch. */
export function hasOfferBenefits(offer: PartnerOffer): boolean {
  return offer.basisPoints > 0 || offer.waivedPickupIds.length > 0;
}

/**
 * Price a selection using integer arithmetic and a server-resolved offer.
 * A payment minimum is required whenever benefits are applied, including a 100% offer.
 * Legacy, unadjusted prices are not subjected to a new provider policy.
 */
export function priceWithPartnerOffer(input: {
  readonly service: Priceable;
  readonly quantity: number;
  readonly pickup: string | null;
  readonly offer: PartnerOffer | null;
  readonly minimumChargeMinor: number | null;
}): PartnerOfferResult<OfferPricing> {
  const { service, quantity, pickup, minimumChargeMinor } = input;
  const parsed = input.offer === null ? null : parsePartnerOffer(input.offer);
  if (parsed && !parsed.ok) return parsed;
  const offer = parsed?.ok && parsed.value.enabled && hasOfferBenefits(parsed.value) ? parsed.value : null;
  if (offer && !isPricingFormula(service.pricing)) {
    return failure('unsupported_pricing', 'Partner benefits require formula pricing; tier prices have no service/pickup decomposition.');
  }
  let originalTotalMinor: number;
  try {
    originalTotalMinor = priceFor(service, quantity, pickup);
  } catch {
    return failure('invalid_price', 'The selected quantity and pickup have no configured price.');
  }
  if (!Number.isSafeInteger(originalTotalMinor) || originalTotalMinor < 0) {
    return failure('invalid_price', 'Price must be a nonnegative safe integer in currency minor units.');
  }
  let serviceSubtotalMinor: number | null = null;
  let pickupSubtotalMinor: number | null = null;
  if (isPricingFormula(service.pricing)) {
    const formula = service.pricing;
    const units = unitsFor(formula, quantity);
    const surcharge = pickup === null ? 0 : formula.surcharges[pickup];
    if (!Number.isSafeInteger(formula.baseMinor) || formula.baseMinor < 0 || surcharge === undefined || !Number.isSafeInteger(surcharge) || surcharge < 0) {
      return failure('invalid_price', 'Service and pickup prices must be nonnegative safe integers.');
    }
    serviceSubtotalMinor = formula.baseMinor * units;
    pickupSubtotalMinor = surcharge * (formula.surchargeScope === 'unit' ? units : 1);
    if (!Number.isSafeInteger(serviceSubtotalMinor) || !Number.isSafeInteger(pickupSubtotalMinor)) {
      return failure('invalid_price', 'Service or pickup subtotal exceeds the safe integer range.');
    }
  }
  // BigInt preserves half-up rounding even when subtotal × basis points exceeds Number's range.
  const serviceDiscountMinor = offer && serviceSubtotalMinor !== null
    ? Number((BigInt(serviceSubtotalMinor) * BigInt(offer.basisPoints) + 5_000n) / 10_000n)
    : 0;
  const waivedPickupId = offer && pickup !== null && offer.waivedPickupIds.includes(pickup) ? pickup : null;
  const pickupDiscountMinor = waivedPickupId === null ? 0 : (pickupSubtotalMinor ?? 0);
  const savingsMinor = serviceDiscountMinor + pickupDiscountMinor;
  const priceMinor = originalTotalMinor - savingsMinor;
  if (offer && (minimumChargeMinor === null || !Number.isSafeInteger(minimumChargeMinor) || minimumChargeMinor < 1 || priceMinor < minimumChargeMinor)) {
    return failure('payment_floor', 'Offer total must meet an explicitly configured positive payment minimum; free tours are not supported.');
  }
  return {
    ok: true,
    value: {
      serviceSubtotalMinor, pickupSubtotalMinor, originalTotalMinor, serviceDiscountMinor,
      pickupDiscountMinor, savingsMinor, priceMinor,
      appliedOffer: offer ? { basisPoints: offer.basisPoints, waivedPickupId } : null,
    },
  };
}

/** Parse stored amounts without treating corrupt snapshots as an absent offer. */
export function parseOfferPricingSnapshot(input: unknown): PartnerOfferResult<OfferPricing> {
  if (!input || typeof input !== 'object'
    || !('serviceSubtotalMinor' in input) || !('pickupSubtotalMinor' in input)
    || !('originalTotalMinor' in input) || !('serviceDiscountMinor' in input)
    || !('pickupDiscountMinor' in input) || !('savingsMinor' in input)
    || !('priceMinor' in input) || !('appliedOffer' in input)) {
    return failure('invalid_price', 'Stored pricing snapshot is incomplete.');
  }
  const { serviceSubtotalMinor, pickupSubtotalMinor, originalTotalMinor, serviceDiscountMinor, pickupDiscountMinor, savingsMinor, priceMinor } = input;
  const minor = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (!minor(originalTotalMinor) || !minor(serviceDiscountMinor) || !minor(pickupDiscountMinor) || !minor(savingsMinor) || !minor(priceMinor)
    || (serviceSubtotalMinor !== null && !minor(serviceSubtotalMinor)) || (pickupSubtotalMinor !== null && !minor(pickupSubtotalMinor))
    || (serviceSubtotalMinor === null) !== (pickupSubtotalMinor === null)
    || savingsMinor !== serviceDiscountMinor + pickupDiscountMinor || priceMinor !== originalTotalMinor - savingsMinor
    || (serviceSubtotalMinor !== null && pickupSubtotalMinor !== null && originalTotalMinor !== serviceSubtotalMinor + pickupSubtotalMinor)) {
    return failure('invalid_price', 'Stored pricing snapshot amounts are inconsistent.');
  }
  let appliedOffer: AppliedPartnerOffer | null = null;
  if (input.appliedOffer !== null) {
    const value = input.appliedOffer;
    if (!value || typeof value !== 'object' || !('basisPoints' in value) || !('waivedPickupId' in value)
      || !minor(value.basisPoints) || value.basisPoints > 10_000
      || (value.waivedPickupId !== null && (typeof value.waivedPickupId !== 'string' || !value.waivedPickupId))
      || serviceSubtotalMinor === null || pickupSubtotalMinor === null) {
      return failure('invalid_price', 'Stored applied offer is invalid.');
    }
    appliedOffer = { basisPoints: value.basisPoints, waivedPickupId: value.waivedPickupId };
    if (serviceDiscountMinor !== Number((BigInt(serviceSubtotalMinor) * BigInt(appliedOffer.basisPoints) + 5_000n) / 10_000n)
      || pickupDiscountMinor !== (appliedOffer.waivedPickupId === null ? 0 : pickupSubtotalMinor)) {
      return failure('invalid_price', 'Stored applied offer disagrees with its amounts.');
    }
  } else if (savingsMinor !== 0) {
    return failure('invalid_price', 'Stored savings require an applied offer.');
  }
  return { ok: true, value: { serviceSubtotalMinor, pickupSubtotalMinor, originalTotalMinor, serviceDiscountMinor, pickupDiscountMinor, savingsMinor, priceMinor, appliedOffer } };
}

/**
 * Whether one service can be sold with an offer's benefits at every party size and pickup.
 * Pickup waivers this service does not offer confer nothing here, so they are not an error.
 */
export function checkPartnerOfferForService(offer: PartnerOffer, service: Priceable, minimumChargeMinor: number | null): PartnerOfferResult<PartnerOffer> {
  const parsed = parsePartnerOffer(offer);
  if (!parsed.ok || !hasOfferBenefits(parsed.value)) return parsed;
  if (!isPricingFormula(service.pricing)) return failure('unsupported_pricing', 'Tier pricing has no service/pickup decomposition. Convert it to formula pricing before assigning partner benefits.');
  const formula = service.pricing;
  const pickups = Object.keys(formula.surcharges);
  // With nonnegative components and <=100% service discount, payable totals are monotone
  // in occupied units. Endpoints catch the lowest payable amount and largest integer bound
  // without making validation proportional to an operator's configured capacity.
  for (const units of new Set([1, formula.maxUnits])) {
    for (const pickup of pickups.length ? pickups : [null]) {
      const result = priceWithPartnerOffer({ service, quantity: units * formula.seatsPerUnit, pickup, offer: { ...parsed.value, enabled: true }, minimumChargeMinor });
      if (!result.ok) return result;
    }
  }
  return parsed;
}

/**
 * Check every sold service/party/pickup before saving benefits, even while disabled.
 * Pickup IDs belong to the union of configured options; missing IDs on other tours confer no waiver.
 */
export function checkPartnerOfferForServices(
  offer: PartnerOffer,
  services: readonly { readonly slug: string; readonly service: Priceable; readonly pickupIds: readonly string[] }[],
  minimumChargeMinor: number | null,
): PartnerOfferResult<PartnerOffer> {
  const parsed = parsePartnerOffer(offer);
  if (!parsed.ok) return parsed;
  const ids = new Set(services.flatMap((entry) => entry.pickupIds));
  if (offer.waivedPickupIds.some((id) => !ids.has(id))) return failure('invalid_offer', 'Select pickup waiver IDs from the configured pickup options.');
  for (const { slug, service } of services) {
    const result = checkPartnerOfferForService(parsed.value, service, minimumChargeMinor);
    if (!result.ok) return failure(result.error.reason, `Service ${slug}: ${result.error.message}`);
  }
  return parsed;
}
