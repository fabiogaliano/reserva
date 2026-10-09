import type { ReservaContext } from '../context.js';
import { resolveService, type ResolvedClientConfig } from '../core/config.js';
import { checkPartnerOfferForServices, parseOfferPercentage, type PartnerOffer } from '../core/partner-offers.js';
import { HttpError, requireString } from '../http.js';
import type { PartnerChanges, PartnerStoreError } from '../partners.js';
import type { AdminChangeAudit } from '../repo.js';

function storeFailure(error: PartnerStoreError): HttpError {
  if (error.reason === 'conflict') return new HttpError(409, 'partner_conflict', error.message);
  if (error.reason === 'unavailable') return new HttpError(503, 'partner_storage_unavailable', 'Partner storage is unavailable.');
  return new HttpError(400, 'validation_failed', error.message, { field: 'code' });
}

function revisionFrom(form: FormData): number {
  const value = Number(form.get('revision'));
  if (!Number.isSafeInteger(value) || value < 1) throw new HttpError(400, 'validation_failed', 'Partner revision is required.', { field: 'revision' });
  return value;
}

function offerServices(config: ResolvedClientConfig): Parameters<typeof checkPartnerOfferForServices>[1] {
  return Object.keys(config.services).map((slug) => {
    const service = resolveService(config, slug);
    return { slug, service, pickupIds: (service.location?.pickupOptions ?? []).map((option) => option.id) };
  });
}

function minimumChargeMinor(context: ReservaContext, config: ResolvedClientConfig): number | null {
  return context.partnerOffers?.minimumChargeMinorByCurrency[config.business.currency] ?? null;
}

/**
 * A settings change must not quietly take a saved offer out of a service's scope: checkout
 * would then charge those referrals the normal price. Offers that were already out of scope
 * (for example after a deployment raised the minimum) do not block unrelated settings edits.
 */
export async function assertPartnerOffersStillSellable(context: ReservaContext, candidate: ResolvedClientConfig): Promise<void> {
  // Without a payment minimum no offer with benefits is sellable, so there is nothing to protect.
  if (!context.partners || !context.partnerOffers) return;
  const listed = await context.partners.list();
  if (!listed.ok) throw new HttpError(503, 'partner_storage_unavailable', 'Partner storage is unavailable.');
  const current = offerServices(context.config);
  const next = offerServices(candidate);
  for (const partner of listed.value) {
    if (partner.state !== 'active' || !partner.offer) continue;
    if (!checkPartnerOfferForServices(partner.offer, current, minimumChargeMinor(context, context.config)).ok) continue;
    const checked = checkPartnerOfferForServices(partner.offer, next, minimumChargeMinor(context, candidate));
    if (!checked.ok) throw new HttpError(400, 'validation_failed', `Partner ${partner.code}: ${checked.error.message}`, { field: 'partner_offers' });
  }
}

function changesFrom(form: FormData, context: ReservaContext): PartnerChanges {
  const name = requireString(form.get('name'), 'name').trim();
  if (name.length > 200) throw new HttpError(400, 'validation_failed', 'Partner name must be at most 200 characters.', { field: 'name' });
  const state = form.get('state');
  if (state !== 'active' && state !== 'archived') throw new HttpError(400, 'validation_failed', 'Partner state must be active or archived.', { field: 'state' });
  const percent = parseOfferPercentage(requireString(form.get('percentage'), 'percentage'));
  if (!percent.ok) throw new HttpError(400, 'validation_failed', percent.error.message, { field: 'percentage' });
  const waivedPickupIds: string[] = [];
  for (const raw of form.getAll('waived_pickup')) waivedPickupIds.push(requireString(raw, 'waived_pickup'));
  const enabled = form.get('offer_enabled') === 'on';
  const offer: PartnerOffer | null = percent.value !== 0 || waivedPickupIds.length !== 0 || enabled
    ? { enabled, basisPoints: percent.value, waivedPickupIds } : null;
  if (offer) {
    const checked = checkPartnerOfferForServices(offer, offerServices(context.config), minimumChargeMinor(context, context.config));
    if (!checked.ok) {
      const field = checked.error.reason === 'unsupported_pricing' ? 'offer.pricing'
        : checked.error.reason === 'payment_floor' ? 'offer.payment_floor' : 'offer.pickup';
      throw new HttpError(400, 'validation_failed', checked.error.message, { field });
    }
  }
  return { name, state, offer };
}

/**
 * Called only after the shared admin authentication, origin and CSRF gates.
 * Partner mutations intentionally emit no settings/rebuild event.
 */
export async function performPartnerAdminAction(context: ReservaContext, form: FormData, action: string, audit: AdminChangeAudit): Promise<void> {
  const store = context.partners;
  if (!store) throw new HttpError(503, 'partner_storage_unavailable', 'Partner storage is unavailable.');
  if (action === 'partner-create') {
    const result = await store.create({ id: crypto.randomUUID(), code: requireString(form.get('code'), 'code'), changes: changesFrom(form, context) }, audit);
    if (!result.ok) throw storeFailure(result.error);
    return;
  }
  if (action !== 'partner-save' && action !== 'partner-archive') throw new HttpError(400, 'validation_failed', 'Unknown partner action.');
  const id = requireString(form.get('partner_id'), 'partner_id');
  const code = requireString(form.get('code'), 'code');
  const found = await store.findByCode(code);
  if (!found.ok) throw storeFailure(found.error);
  if (!found.value || found.value.id !== id) throw new HttpError(404, 'not_found', 'Partner not found.');
  const changes = action === 'partner-archive'
    ? { name: found.value.name, state: 'archived' as const, offer: found.value.offer }
    : changesFrom(form, context);
  const result = await store.save(id, revisionFrom(form), changes, audit);
  if (!result.ok) throw storeFailure(result.error);
}
