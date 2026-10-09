import type { QuoteResponse, ReferralBenefit, ReferralResolution } from './core/api.js';
import type { ResolvedClientConfig, ResolvedServiceConfig } from './core/config.js';
import { resolveService } from './core/config.js';
import { checkPartnerOfferForService, hasOfferBenefits, priceWithPartnerOffer, type PartnerOffer, type PartnerOffersPolicy } from './core/partner-offers.js';
import type { Priceable } from './core/pricing.js';
import { sha256Base64Url } from './http.js';
import { parseReferralCode, type PartnerRecord, type PartnerStore } from './partners.js';

/** Dependencies are read once per request, after stored settings have been merged. */
export interface ReferralPricingContext {
  readonly config: ResolvedClientConfig;
  readonly partners?: Pick<PartnerStore, 'findByCode'>;
  readonly partnerOffers?: PartnerOffersPolicy;
}

/** Expected failures must not turn into an unavailable/full-price referral. */
export class ReferralPricingError extends Error {
  readonly _tag = 'ReferralPricingError' as const;
  constructor(readonly reason: 'invalid_code' | 'storage' | 'pricing', message: string, readonly cause?: unknown) {
    super(message);
  }
}

/** Result at the referral application seam. */
export type ReferralPricingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ReferralPricingError };

/** Private resolution retains only this code's operator record for the checkout snapshot. */
export interface ResolvedReferral {
  readonly code: string | null;
  readonly partner: PartnerRecord | null;
  readonly public: ReferralResolution | { status: 'none' };
}

function minimumChargeMinor(context: ReferralPricingContext): number | null {
  return context.partnerOffers?.minimumChargeMinorByCurrency[context.config.business.currency] ?? null;
}

/**
 * A price edit or a raised payment minimum can leave a saved offer unsellable for a service.
 * That service is then out of the offer's scope, advertised and charged at its normal price,
 * rather than refusing every quote for customers who arrived through the link.
 */
function offerFor(context: ReferralPricingContext, partner: PartnerRecord | null, service: Priceable): PartnerOffer | null {
  const offer = partner?.offer;
  if (context.partnerOffers?.enabled !== true || !offer?.enabled || !hasOfferBenefits(offer)) return null;
  return checkPartnerOfferForService(offer, service, minimumChargeMinor(context)).ok ? offer : null;
}

function benefitsFor(context: ReferralPricingContext, partner: PartnerRecord): ReferralBenefit[] {
  return Object.keys(context.config.services).flatMap((serviceSlug) => {
    const service = resolveService(context.config, serviceSlug);
    const offer = offerFor(context, partner, service);
    if (!offer) return [];
    return [{
      serviceSlug,
      serviceDiscountBasisPoints: offer.basisPoints,
      waivedPickupIds: (service.location?.pickupOptions ?? []).map((option) => option.id).filter((id) => offer.waivedPickupIds.includes(id)),
    }];
  });
}

/** Resolve exactly one supplied code; absent codes never issue a registry query. */
export async function resolveReferral(context: ReferralPricingContext, input: unknown): Promise<ReferralPricingResult<ResolvedReferral>> {
  if (input === undefined) return { ok: true, value: { code: null, partner: null, public: { status: 'none' } } };
  const parsed = parseReferralCode(input);
  if (!parsed.ok) return { ok: false, error: new ReferralPricingError('invalid_code', parsed.error.message) };
  if (!context.partners) return { ok: false, error: new ReferralPricingError('storage', 'Partner registry is unavailable.') };
  const found = await context.partners.findByCode(parsed.value);
  if (!found.ok) return { ok: false, error: new ReferralPricingError('storage', 'Partner registry is unavailable.', found.error) };
  const partner = found.value?.state === 'active' ? found.value : null;
  return {
    ok: true,
    value: {
      code: parsed.value, partner,
      public: partner ? { status: 'active', benefits: benefitsFor(context, partner) } : { status: 'unavailable' },
    },
  };
}

/**
 * Compute quote and private attribution from one settings/offer view, shared by checkout.
 * The fingerprint is only a comparison: checkout recomputes every amount independently.
 * Partner names/revisions do not cause price review; archival, benefits and amounts do.
 */
export async function quoteReferralSelection(
  context: ReferralPricingContext,
  input: { readonly serviceSlug: string; readonly service: ResolvedServiceConfig; readonly quantity: number; readonly pickup: string | null; readonly referralCode: unknown },
): Promise<ReferralPricingResult<{ readonly quote: QuoteResponse; readonly referral: ResolvedReferral }>> {
  // Read the policy once, before the registry await, so descriptors and amounts come from the
  // same gate even if the context's policy is replaced meanwhile.
  const view: ReferralPricingContext = {
    config: context.config,
    ...(context.partners ? { partners: context.partners } : {}),
    ...(context.partnerOffers ? { partnerOffers: context.partnerOffers } : {}),
  };
  const resolved = await resolveReferral(view, input.referralCode);
  if (!resolved.ok) return resolved;
  const referral = resolved.value;
  const priced = priceWithPartnerOffer({
    service: input.service, quantity: input.quantity, pickup: input.pickup,
    offer: offerFor(view, referral.partner, input.service), minimumChargeMinor: minimumChargeMinor(view),
  });
  if (!priced.ok) return { ok: false, error: new ReferralPricingError('pricing', priced.error.message, priced.error) };
  const publicReferral = referral.public.status === 'active'
    ? { ...referral.public, benefits: referral.public.benefits.filter((benefit) => benefit.serviceSlug === input.serviceSlug) }
    : referral.public;
  const currency = view.config.business.currency;
  const quoteFingerprint = 'quote_v1.' + await sha256Base64Url(JSON.stringify({
    serviceSlug: input.serviceSlug, quantity: input.quantity, pickup: input.pickup,
    referralCode: referral.code, partnerId: referral.partner?.id ?? null,
    currency, pricing: priced.value, referral: publicReferral,
  }));
  return {
    ok: true,
    value: {
      referral,
      quote: { priceMinor: priced.value.priceMinor, currency, pricing: priced.value, referral: publicReferral, quoteFingerprint },
    },
  };
}
