import { describe, expect, it } from 'vitest';
import { checkPartnerOfferForServices, parseOfferPercentage, parsePartnerOffer, parseOfferPricingSnapshot, priceWithPartnerOffer, type PartnerOffer } from '../src/core/partner-offers';
import type { Priceable } from '../src/core/pricing';

const service: Priceable = { pricing: { baseMinor: 10_000, surcharges: { meeting: 0, custom: 2_000 }, seatsPerUnit: 4, maxUnits: 2, surchargeScope: 'booking' } };
const combined: PartnerOffer = { enabled: true, basisPoints: 1_000, waivedPickupIds: ['custom'] };

function price(offer: PartnerOffer | null, quantity = 4, pickup = 'custom', selectedService = service, minimumChargeMinor: number | null = 50) {
  return priceWithPartnerOffer({ service: selectedService, quantity, pickup, offer, minimumChargeMinor });
}

function amounts(result: ReturnType<typeof price>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

describe('partner pricing', () => {
  it.each([
    [null, 12_000, 0, 0],
    [{ ...combined, waivedPickupIds: [] }, 11_000, 1_000, 0],
    [{ ...combined, basisPoints: 0 }, 10_000, 0, 2_000],
    [combined, 9_000, 1_000, 2_000],
    [{ ...combined, enabled: false }, 12_000, 0, 0],
  ])('prices service and pickup independently: %j', (offer, total, serviceSaving, pickupSaving) => {
    expect(amounts(price(offer))).toMatchObject({ serviceSubtotalMinor: 10_000, pickupSubtotalMinor: 2_000, originalTotalMinor: 12_000, serviceDiscountMinor: serviceSaving, pickupDiscountMinor: pickupSaving, priceMinor: total, savingsMinor: serviceSaving + pickupSaving });
  });

  it('charges per-booking pickup once for the 8-guest tier', () => {
    expect(amounts(price(combined, 8))).toMatchObject({ serviceSubtotalMinor: 20_000, pickupSubtotalMinor: 2_000, originalTotalMinor: 22_000, priceMinor: 18_000 });
    expect(amounts(price(combined, 5)).priceMinor).toBe(18_000);
  });

  it('waives the full per-unit surcharge, without discounting it twice', () => {
    const perUnit: Priceable = { pricing: { baseMinor: 10_000, surcharges: { custom: 2_000 }, seatsPerUnit: 4, maxUnits: 2, surchargeScope: 'unit' } };
    expect(amounts(price(combined, 8, 'custom', perUnit))).toMatchObject({ pickupSubtotalMinor: 4_000, pickupDiscountMinor: 4_000, priceMinor: 18_000 });
  });

  it('does not apply an unselected pickup waiver', () => {
    expect(amounts(price(combined, 4, 'meeting'))).toMatchObject({ pickupDiscountMinor: 0, priceMinor: 9_000, appliedOffer: { basisPoints: 1_000, waivedPickupId: null } });
  });

  it('supports a formula without a pickup axis', () => {
    const result = priceWithPartnerOffer({ service: { pricing: { baseMinor: 100, surcharges: {}, maxUnits: 1, seatsPerUnit: 1, surchargeScope: 'booking' } }, quantity: 1, pickup: null, offer: combined, minimumChargeMinor: 50 });
    expect(amounts(result)).toMatchObject({ pickupSubtotalMinor: 0, priceMinor: 90 });
  });

  it('rounds the service discount exactly once, halves upward', () => {
    const odd: Priceable = { pricing: { baseMinor: 101, surcharges: { meeting: 0 }, seatsPerUnit: 1, maxUnits: 2, surchargeScope: 'booking' } };
    expect(amounts(price({ enabled: true, basisPoints: 5_000, waivedPickupIds: [] }, 1, 'meeting', odd)).serviceDiscountMinor).toBe(51);
    expect(amounts(price({ enabled: true, basisPoints: 5_000, waivedPickupIds: [] }, 2, 'meeting', odd)).serviceDiscountMinor).toBe(101);
  });

  it('retains integer precision for large safe subtotals', () => {
    const baseMinor = Number.MAX_SAFE_INTEGER;
    const large: Priceable = { pricing: { baseMinor, surcharges: { meeting: 0 }, seatsPerUnit: 1, maxUnits: 1, surchargeScope: 'booking' } };
    const result = amounts(price({ enabled: true, basisPoints: 1, waivedPickupIds: [] }, 1, 'meeting', large));
    expect(result.serviceDiscountMinor).toBe(Number((BigInt(baseMinor) + 5_000n) / 10_000n));
    expect(result.priceMinor + result.savingsMinor).toBe(baseMinor);
  });

  it('preserves legacy tier prices without inventing a pickup component', () => {
    const tiers: Priceable = { pricing: [{ maxQuantity: 4, pickup: 'custom', priceMinor: 12_000 }] };
    expect(amounts(price(null, 4, 'custom', tiers))).toMatchObject({ serviceSubtotalMinor: null, pickupSubtotalMinor: null, priceMinor: 12_000, appliedOffer: null });
    expect(price(combined, 4, 'custom', tiers)).toMatchObject({ ok: false, error: { reason: 'unsupported_pricing' } });
    expect(amounts(price({ ...combined, enabled: false }, 4, 'custom', tiers)).priceMinor).toBe(12_000);
  });

  it.each([null, 0, -1, 0.5, 10_000])('rejects unsupported payment floor %s rather than clamping', (minimum) => {
    expect(price(combined, 4, 'custom', service, minimum)).toMatchObject({ ok: false, error: { reason: 'payment_floor' } });
  });

  it('rejects free and below-minimum tours, including the €1 test tour', () => {
    const cheap: Priceable = { pricing: { baseMinor: 100, surcharges: { meeting: 0 }, seatsPerUnit: 1, maxUnits: 1, surchargeScope: 'booking' } };
    expect(price({ ...combined, basisPoints: 10_000 }, 4)).toMatchObject({ ok: false, error: { reason: 'payment_floor' } });
    expect(price({ ...combined, basisPoints: 5_050 }, 1, 'meeting', cheap)).toMatchObject({ ok: false, error: { reason: 'payment_floor' } });
    expect(amounts(price({ ...combined, basisPoints: 5_000 }, 1, 'meeting', cheap)).priceMinor).toBe(50);
    expect(price({ ...combined, basisPoints: 9_999 }, 4)).toMatchObject({ ok: false, error: { reason: 'payment_floor' } });
  });

  it.each([0, -1, 1.5, 9, NaN])('rejects an invalid party %s', (quantity) => {
    expect(price(combined, quantity)).toMatchObject({ ok: false, error: { reason: 'invalid_price' } });
  });

  it('rejects invalid price components and unsafe totals', () => {
    const invalid: Priceable = { pricing: { baseMinor: 100.5, surcharges: { custom: 0.5 }, seatsPerUnit: 4, maxUnits: 2, surchargeScope: 'booking' } };
    expect(price(combined, 4, 'custom', invalid)).toMatchObject({ ok: false, error: { reason: 'invalid_price' } });
    const unsafe: Priceable = { pricing: { baseMinor: Number.MAX_SAFE_INTEGER, surcharges: { custom: 1 }, seatsPerUnit: 4, maxUnits: 2, surchargeScope: 'booking' } };
    expect(price(null, 8, 'custom', unsafe)).toMatchObject({ ok: false, error: { reason: 'invalid_price' } });
  });
});

describe('stored offer pricing', () => {
  it('round-trips formula and legacy tier snapshots without losing component meaning', () => {
    const formula = amounts(price(combined));
    const tiers = amounts(price(null, 4, 'custom', { pricing: [{ maxQuantity: 4, pickup: 'custom', priceMinor: 12_000 }] }));
    for (const value of [formula, tiers]) expect(parseOfferPricingSnapshot(JSON.parse(JSON.stringify(value)))).toEqual({ ok: true, value });
  });

  it('rejects inconsistent money, decomposition and applied benefits instead of silently dropping them', () => {
    const snapshot = amounts(price(combined));
    const corrupt = [
      null, {}, { ...snapshot, priceMinor: 1 }, { ...snapshot, savingsMinor: 1 },
      { ...snapshot, serviceSubtotalMinor: null }, { ...snapshot, originalTotalMinor: 12_001 },
      { ...snapshot, appliedOffer: null }, { ...snapshot, appliedOffer: { basisPoints: 100_000, waivedPickupId: 'custom' } },
      { ...snapshot, appliedOffer: { basisPoints: 500, waivedPickupId: 'custom' } },
      { ...snapshot, appliedOffer: { basisPoints: 1_000, waivedPickupId: null } },
    ];
    for (const input of corrupt) expect(parseOfferPricingSnapshot(input)).toMatchObject({ ok: false, error: { reason: 'invalid_price' } });
  });
});

describe('offer parsing and catalog-wide eligibility', () => {
  it.each([['0', 0], ['10', 1_000], ['10.25', 1_025], ['0.01', 1], [' 99.99 ', 9_999], ['100.00', 10_000]])('parses percentage %s exactly', (text, expected) => {
    expect(parseOfferPercentage(text)).toEqual({ ok: true, value: expected });
  });

  it.each(['', '-1', '100.01', '10.001', '1e1', 'NaN', 'Infinity', '.5', '10,25'])('rejects percentage %s', (text) => {
    expect(parseOfferPercentage(text).ok).toBe(false);
  });

  it.each([null, {}, { ...combined, basisPoints: 1.5 }, { ...combined, enabled: 1 }, { ...combined, basisPoints: 10_001 }, { ...combined, waivedPickupIds: ['custom', 'custom'] }, { ...combined, waivedPickupIds: [1] }])('rejects malformed offer %j', (input) => {
    expect(parsePartnerOffer(input).ok).toBe(false);
  });

  it('validates configured pickup IDs, unsupported tours and payment floors even when disabled', () => {
    const services = [{ slug: 'tour', service, pickupIds: ['meeting', 'custom'] }];
    expect(checkPartnerOfferForServices(combined, services, 50).ok).toBe(true);
    expect(checkPartnerOfferForServices({ ...combined, waivedPickupIds: ['unknown'] }, services, 50)).toMatchObject({ ok: false, error: { reason: 'invalid_offer' } });
    expect(checkPartnerOfferForServices({ ...combined, enabled: false, waivedPickupIds: [] }, [{ slug: 'tiers', service: { pricing: [{ maxQuantity: 1, priceMinor: 100 }] }, pickupIds: [] }], 50)).toMatchObject({ ok: false, error: { reason: 'unsupported_pricing' } });
    expect(checkPartnerOfferForServices({ ...combined, enabled: false, basisPoints: 10_000 }, services, 50)).toMatchObject({ ok: false, error: { reason: 'payment_floor' } });
  });

  it('allows partners with no benefits on tier services', () => {
    expect(checkPartnerOfferForServices({ enabled: true, basisPoints: 0, waivedPickupIds: [] }, [{ slug: 'tiers', service: { pricing: [{ maxQuantity: 1, priceMinor: 100 }] }, pickupIds: [] }], null).ok).toBe(true);
  });
});
