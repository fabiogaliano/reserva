// How partners and their offers read across the operator pages, so the partners page, the change
// history and a booking's details describe one offer in the same words.
import { resolveLocalizedText, resolveService, type ResolvedClientConfig } from '../core/config.js';
import { numberFormat } from '../core/intl.js';
import { formatLocaleFor } from '../core/locale.js';
import type { PartnerOffer } from '../core/partner-offers.js';
import { isPricingFormula } from '../core/pricing.js';
import type { ReservaMessages } from './messages.js';
import { formatMessage } from './messages.js';

export interface PartnerPickup {
  readonly id: string;
  readonly label: string;
  /** What the pickup normally adds to a booking, when every tour charges the same once per booking. */
  readonly chargeMinor: number | null;
  /** Whether any tour charges for it: waiving a pickup that costs nothing gives the customer nothing. */
  readonly charged: boolean;
}

/** Every pickup option across the tours, in first-seen order. */
export function partnerPickups(config: ResolvedClientConfig, locale: string, messages: ReservaMessages): PartnerPickup[] {
  const found = new Map<string, { label: string; charges: Set<number | null> }>();
  for (const slug of Object.keys(config.services)) {
    const service = resolveService(config, slug);
    for (const option of service.location?.pickupOptions ?? []) {
      const entry = found.get(option.id) ?? { label: resolveLocalizedText(option.label ?? messages['pickup.meetingPoint'], locale, config.locales.default), charges: new Set() };
      const pricing = service.pricing;
      // A per-unit charge has no single amount to quote, and tier prices hide the pickup's share.
      entry.charges.add(isPricingFormula(pricing) ? (pricing.surchargeScope === 'booking' ? pricing.surcharges[option.id] ?? 0 : (pricing.surcharges[option.id] ?? 0) > 0 ? null : 0) : null);
      found.set(option.id, entry);
    }
  }
  return [...found].map(([id, { label, charges }]) => {
    const only = charges.size === 1 ? [...charges][0] ?? null : null;
    return { id, label, chargeMinor: only !== null && only > 0 ? only : null, charged: [...charges].some((charge) => charge !== 0) };
  });
}

export function formatPercentage(basisPoints: number, locale: string): string {
  return numberFormat(formatLocaleFor(locale), { maximumFractionDigits: 2 }).format(basisPoints / 100);
}

/** The offer's benefits as short labels: "10% off", "Custom pickup free of charge". */
export function offerTags(offer: PartnerOffer, pickups: readonly PartnerPickup[], locale: string, messages: ReservaMessages): string[] {
  const tags: string[] = [];
  if (offer.basisPoints > 0) tags.push(formatMessage(messages['partner.discountTag'], { percentage: formatPercentage(offer.basisPoints, locale) }));
  for (const id of offer.waivedPickupIds) {
    tags.push(formatMessage(messages['partner.pickupTag'], { pickup: pickups.find((pickup) => pickup.id === id)?.label ?? id }));
  }
  return tags;
}

export function partnerHref(adminPath: string, id: string): string {
  return `${adminPath}?view=partners&partner=${encodeURIComponent(id)}`;
}

export function referralUrl(config: ResolvedClientConfig, code: string): string {
  const url = new URL(config.business.url);
  url.searchParams.set('ref', code);
  return url.toString();
}
