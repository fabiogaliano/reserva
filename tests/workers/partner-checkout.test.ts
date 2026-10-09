import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createReservaContext, type ReservaContext } from '../../src/context';
import type { QuoteResponse } from '../../src/core/api';
import type { Booking } from '../../src/core/booking';
import type { ResolvedServiceConfig } from '../../src/core/config';
import { handleCheckout, handleCustomerReschedule, handleManage, handleOperatorCancel, handlePaymentWebhook, handleQuote, handleResolveReferral, handleStatus } from '../../src/handlers';
import { createPartnerStore, PartnerStoreError, type PartnerRecord } from '../../src/partners';
import { defineCloudflareReservaRuntime } from '../../src/runtime-context';
import { config, service } from '../fixtures';
import { providers } from '../fakes';

function isD1(value: unknown): value is D1Database {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'prepare') === 'function';
}
const binding: unknown = Reflect.get(env, 'RESERVA_DB');
if (!isD1(binding)) throw new Error('Missing RESERVA_DB test binding');
const db = binding;
const store = createPartnerStore(db);
const NOW = '2026-06-14T08:00:00.000Z';
const START = '2026-06-15T08:00:00.000Z';
const audit = { actor: 'admin', changedAt: NOW };
const formula: ResolvedServiceConfig = { ...service, pricing: { baseMinor: 10_000, surcharges: { default: 0, custom: 2_000 }, maxUnits: 2, seatsPerUnit: 4, surchargeScope: 'booking', inherited: { surcharges: false, maxUnits: false, surchargeScope: false } } };

beforeEach(async () => {
  await db.prepare('DELETE FROM side_effect_operations').run();
  await db.prepare('DELETE FROM refund_operations').run();
  await db.prepare('DELETE FROM operational_incidents').run();
  await db.prepare('DELETE FROM bookings').run();
  await db.prepare('DELETE FROM day_overrides').run();
  await db.prepare('DELETE FROM capacity_defaults').run();
});

async function partner(enabled = true): Promise<PartnerRecord> {
  const id = crypto.randomUUID();
  const result = await store.create({ id, code: `partner-${id}`, changes: { name: 'Operator-only partner label', state: 'active', offer: { enabled, basisPoints: 1_000, waivedPickupIds: ['custom'] } } }, audit);
  if (!result.ok) throw result.error;
  return result.value;
}

function harness(enabled = true, selectedService = formula) {
  const charges: Booking[] = [];
  const context = createReservaContext({
    config: { ...config, services: { vintage: selectedService } }, db,
    partnerOffers: { enabled, minimumChargeMinorByCurrency: { eur: 50 }, legacyMetadataField: 'partner' },
    clock: () => new Date(NOW),
    secrets: (name) => name === 'RESERVA_TOKEN_ENC_KEY' ? 'local-test-token-encryption-key' : undefined,
    providers: providers({ payments: {
      ...providers().payments,
      createCheckout: async (booking) => {
        charges.push(booking);
        return { url: 'https://checkout.test', sessionRef: `cs_${booking.id}` };
      },
    } }),
  });
  return { context, charges };
}

function request(body: Record<string, unknown>): Request {
  return new Request('https://example.test/api/booking', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function quote(context: ReservaContext, code?: string, overrides: Record<string, unknown> = {}): Promise<QuoteResponse> {
  const response = await handleQuote(request({ serviceSlug: 'vintage', quantity: 4, pickup: 'custom', ...(code === undefined ? {} : { referralCode: code }), ...overrides }), context);
  expect(response.status).toBe(200);
  // SAFETY: This test consumes handleQuote's typed successful JSON envelope after checking status.
  return await response.json() as QuoteResponse;
}

function checkout(context: ReservaContext, code?: string, fingerprint?: string, overrides: Record<string, unknown> = {}) {
  return handleCheckout(request({ serviceSlug: 'vintage', start: START, quantity: 4, pickup: 'custom', locale: 'en', ...(code === undefined ? {} : { referralCode: code }), ...(fingerprint === undefined ? {} : { quoteFingerprint: fingerprint }), ...overrides }), context);
}

const holdCount = async () => (await db.prepare('SELECT COUNT(*) AS n FROM bookings').first<{ n: number }>())?.n;

async function save(partner: PartnerRecord, changes: Parameters<typeof store.save>[2]): Promise<PartnerRecord> {
  const result = await store.save(partner.id, partner.revision, changes, audit);
  if (!result.ok) throw result.error;
  return result.value;
}

describe('partner API through real D1 and checkout/payment boundary', () => {
  it('resolves only one supplied code, with safe service-scoped descriptors and no operator names', async () => {
    const current = await partner();
    const other = await partner();
    const { context } = harness();
    const response = await handleResolveReferral(request({ referralCode: current.code }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ status: 'active', benefits: [{ serviceSlug: 'vintage', serviceDiscountBasisPoints: 1_000, waivedPickupIds: ['custom'] }] });
    for (const privateValue of [current.name, current.id, current.code, other.code, other.id]) expect(text).not.toContain(privateValue);
    const invalid = await handleResolveReferral(request({ referralCode: ['not', 'one-code'] }), context);
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain(other.code);
    const get = await handleResolveReferral(new Request('https://example.test/api/booking/referral'), context);
    expect(get.status).toBe(405);
    expect(get.headers.get('cache-control')).toBe('no-store');
  });

  it('quotes and charges the same amounts for 4/8 guests without trusting forged browser totals', async () => {
    const current = await partner();
    for (const quantity of [4, 8]) {
      const { context, charges } = harness();
      const reviewed = await quote(context, current.code, { quantity });
      expect(reviewed.priceMinor).toBe(quantity === 4 ? 9_000 : 18_000);
      const response = await checkout(context, current.code, reviewed.quoteFingerprint, { quantity, priceMinor: 1, basisPoints: 10_000, savingsMinor: 99_999 });
      expect(response.status).toBe(201);
      const charged = charges[0];
      if (!charged) throw new Error('Checkout did not reach the payment boundary');
      expect(charged.priceMinor).toBe(reviewed.priceMinor);
      // An unpaid hold is not yet a booking the partner can be credited with.
      expect(await store.bookingCounts(NOW)).toEqual({ ok: true, value: [] });
      const held = await context.repo.getBookingById(charged.id);
      expect(held).toMatchObject({ partnerId: current.id, partnerAttribution: { code: current.code, name: current.name, revision: 1 }, partnerPricing: reviewed.pricing, priceMinor: reviewed.priceMinor });
      await context.repo.expireHold(charged.id, NOW);
    }
  });

  it('requires a reviewed quote even for disabled or initially unavailable referrals', async () => {
    const disabled = await partner(false);
    const { context, charges } = harness();
    for (const code of [disabled.code, 'unknown-partner']) {
      const response = await checkout(context, code);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed', details: { field: 'quoteFingerprint' } } });
    }
    expect(charges).toHaveLength(0);
    expect(await holdCount()).toBe(0);
  });

  it('quotes initially archived and unknown referrals at normal price without distinguishing them', async () => {
    const current = await partner();
    await save(current, { name: current.name, state: 'archived', offer: current.offer });
    const { context, charges } = harness();
    for (const code of [current.code, 'unknown-partner']) {
      const resolved = await handleResolveReferral(request({ referralCode: code }), context);
      await expect(resolved.json()).resolves.toEqual({ status: 'unavailable' });
      const reviewed = await quote(context, code);
      expect(reviewed).toMatchObject({ priceMinor: 12_000, referral: { status: 'unavailable' }, pricing: { appliedOffer: null } });
      expect((await checkout(context, code, reviewed.quoteFingerprint)).status).toBe(201);
      const charged = charges.at(-1);
      if (!charged) throw new Error('Missing normal-price payment');
      expect(await context.repo.getBookingById(charged.id)).toMatchObject({ partnerId: null, partnerAttribution: null, priceMinor: 12_000 });
      await context.repo.expireHold(charged.id, NOW);
    }
  });

  it.each(['archive', 'disable', 'discount'] as const)('requires review after %s before any hold or payment', async (change) => {
    const current = await partner();
    const { context, charges } = harness();
    const reviewed = await quote(context, current.code);
    await save(current, {
      name: current.name, state: change === 'archive' ? 'archived' : 'active',
      offer: { enabled: change !== 'disable', basisPoints: change === 'discount' ? 2_000 : 1_000, waivedPickupIds: ['custom'] },
    });
    const fresh = await quote(context, current.code);
    expect(fresh.quoteFingerprint).not.toBe(reviewed.quoteFingerprint);
    const response = await checkout(context, current.code, reviewed.quoteFingerprint);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'quote_changed', details: { quote: fresh } } });
    expect(await holdCount()).toBe(0);
    expect(charges).toHaveLength(0);
  });

  it('requires review when a formerly unavailable code becomes active, not only when price increases', async () => {
    const current = await partner();
    const archived = await save(current, { name: current.name, state: 'archived', offer: current.offer });
    const { context, charges } = harness();
    const reviewed = await quote(context, current.code);
    await save(archived, { name: current.name, state: 'active', offer: current.offer });
    expect((await checkout(context, current.code, reviewed.quoteFingerprint)).status).toBe(409);
    expect(charges).toHaveLength(0);
    expect(await holdCount()).toBe(0);
  });

  it('compares selection, price and currency, not just partner edits', async () => {
    const current = await partner();
    const { context, charges } = harness();
    const reviewed = await quote(context, current.code);
    expect((await checkout(context, current.code, reviewed.quoteFingerprint, { pickup: 'default' })).status).toBe(409);
    const changed = harness(true, { ...formula, pricing: { baseMinor: 11_000, surcharges: { default: 0, custom: 2_000 }, maxUnits: 2, seatsPerUnit: 4, surchargeScope: 'booking', inherited: { surcharges: false, maxUnits: false, surchargeScope: false } } });
    expect((await checkout(changed.context, current.code, reviewed.quoteFingerprint)).status).toBe(409);
    const usd = { ...context, config: { ...context.config, business: { ...context.config.business, currency: 'usd' } }, partnerOffers: { enabled: true, minimumChargeMinorByCurrency: { usd: 50 } } };
    expect((await checkout(usd, current.code, reviewed.quoteFingerprint)).status).toBe(409);
    expect(charges).toHaveLength(0);
    expect(changed.charges).toHaveLength(0);
    expect(await holdCount()).toBe(0);
  });

  it('does not advertise/apply benefits while globally off and reviews gate changes', async () => {
    const current = await partner();
    const off = harness(false);
    await expect((await handleResolveReferral(request({ referralCode: current.code }), off.context)).json()).resolves.toEqual({ status: 'active', benefits: [] });
    const reviewed = await quote(off.context, current.code);
    expect(reviewed.priceMinor).toBe(12_000);
    expect((await checkout(off.context, current.code, reviewed.quoteFingerprint)).status).toBe(201);
    const accepted = off.charges[0];
    if (!accepted) throw new Error('Missing gate-off payment');
    expect(accepted.partnerAttribution?.code).toBe(current.code);
    await off.context.repo.expireHold(accepted.id, NOW);
    const on = harness();
    expect((await checkout(on.context, current.code, reviewed.quoteFingerprint)).status).toBe(409);
    expect(on.charges).toHaveLength(0);
  });

  it('defaults application off and resolves an explicit runtime binding callback per request', async () => {
    const current = await partner();
    const { context } = harness();
    delete context.partnerOffers;
    expect(await quote(context, current.code)).toMatchObject({ priceMinor: 12_000, referral: { status: 'active', benefits: [] } });
    const runtime = defineCloudflareReservaRuntime<{ RESERVA_DB: D1Database; RESERVA_PARTNER_OFFERS_ENABLED: string }>({
      providers: providers(),
      partnerOffers: ({ env }) => ({ enabled: env.RESERVA_PARTNER_OFFERS_ENABLED === 'true', minimumChargeMinorByCurrency: { eur: 50 } }),
    });
    for (const enabled of ['false', 'true']) {
      const ctx = await runtime.createContext({ request: new Request('https://example.test/api/booking/referral'), locals: { env: { RESERVA_DB: db, RESERVA_PARTNER_OFFERS_ENABLED: enabled } } });
      expect(ctx.partnerOffers?.enabled).toBe(enabled === 'true');
      expect(JSON.stringify(ctx.config)).not.toContain('minimumChargeMinorByCurrency');
      expect(JSON.stringify(ctx.config)).not.toContain('partnerOffers');
    }
  });

  it('uses one gate/floor policy view across an asynchronous registry read', async () => {
    const current = await partner();
    const { context } = harness();
    context.partners = { ...store, findByCode: async (code) => {
      context.partnerOffers = { enabled: false, minimumChargeMinorByCurrency: {} };
      return store.findByCode(code);
    } };
    const acceptedView = await quote(context, current.code);
    expect(acceptedView).toMatchObject({ priceMinor: 9_000, referral: { status: 'active', benefits: [{ serviceDiscountBasisPoints: 1_000 }] } });
    expect(await quote(context, current.code)).toMatchObject({ priceMinor: 12_000, referral: { status: 'active', benefits: [] } });
  });

  it('allows existing non-referral callers without querying the registry', async () => {
    const { context, charges } = harness();
    context.partners = { ...store, findByCode: async () => ({ ok: false, error: new PartnerStoreError('unavailable', 'Database failed') }) };
    expect((await quote(context)).priceMinor).toBe(12_000);
    expect((await checkout(context)).status).toBe(201);
    expect(charges[0]).toMatchObject({ priceMinor: 12_000, partnerId: null, partnerAttribution: null, partnerPricing: null });
  });

  it('does not turn storage failures into unavailable/full-price checkouts', async () => {
    const current = await partner();
    const { context, charges } = harness();
    const reviewed = await quote(context, current.code);
    await db.prepare("UPDATE partner_offers SET waived_pickup_ids = '[123]' WHERE partner_id = ?").bind(current.id).run();
    for (const response of [await handleResolveReferral(request({ referralCode: current.code }), context), await handleQuote(request({ serviceSlug: 'vintage', quantity: 4, pickup: 'custom', referralCode: current.code }), context), await checkout(context, current.code, reviewed.quoteFingerprint)]) {
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'partner_storage_unavailable' } });
    }
    expect(await holdCount()).toBe(0);
    expect(charges).toHaveLength(0);
  });

  it('keeps the accepted snapshot through a racing edit and gate disable, and projects only safe pricing', async () => {
    const current = await partner();
    const { context, charges } = harness();
    const reviewed = await quote(context, current.code);
    const originalInsert = context.repo.insertHoldWithCapacity;
    context.repo.insertHoldWithCapacity = async (input) => {
      await save(current, { name: 'Changed private label', state: 'archived', offer: null });
      return originalInsert(input);
    };
    expect((await checkout(context, current.code, reviewed.quoteFingerprint)).status).toBe(201);
    const accepted = charges[0];
    if (!accepted) throw new Error('Missing accepted checkout');
    const confirmed = await context.repo.transitionToConfirmed(accepted.id, { expectedStatusIn: ['hold'], paymentRef: `pi_${accepted.id}`, updatedAt: NOW });
    if (!confirmed) throw new Error('Unable to confirm accepted hold');
    const off = { ...context, partnerOffers: { enabled: false, minimumChargeMinorByCurrency: { eur: 50 } } };
    const managed = await handleManage(new Request(`https://example.test/api/booking/manage?token=${confirmed.cancelToken}`), off);
    expect(managed.status).toBe(200);
    const text = await managed.text();
    expect(JSON.parse(text)).toMatchObject({ booking: { priceMinor: 9_000, pricing: reviewed.pricing } });
    expect(text).not.toContain(current.code);
    expect(text).not.toContain(current.name);
    expect(text).not.toContain('Changed private label');
    const status = await handleStatus(new Request(`https://example.test/api/booking/status?sessionId=cs_${accepted.id}`), off);
    await expect(status.json()).resolves.toMatchObject({ status: 'confirmed', booking: { pricing: reviewed.pricing } });
    await expect(db.prepare('UPDATE bookings SET partner_pricing_snapshot = NULL WHERE id = ?').bind(accepted.id).run()).rejects.toThrow('immutable');
    await expect(db.prepare('UPDATE bookings SET price_minor = 12000 WHERE id = ?').bind(accepted.id).run()).rejects.toThrow('immutable');
    expect(await context.repo.getBookingById(accepted.id)).toMatchObject({ partnerAttribution: { code: current.code, name: current.name }, priceMinor: 9_000, partnerPricing: reviewed.pricing });
  });

  it('verifies payment, reschedules and refunds against the accepted discounted amount, never today’s offer', async () => {
    const current = await partner();
    const { context, charges } = harness();
    const reviewed = await quote(context, current.code);
    expect((await checkout(context, current.code, reviewed.quoteFingerprint)).status).toBe(201);
    const accepted = charges[0];
    if (!accepted) throw new Error('Missing accepted checkout');
    await save(current, { name: 'New label', state: 'archived', offer: null });
    let reportedAmount = 12_000;
    const refunds: Array<{ paymentRef: string; amount: number }> = [];
    context.partnerOffers = { enabled: false, minimumChargeMinorByCurrency: { eur: 50 } };
    context.providers.payments = {
      ...context.providers.payments,
      parseWebhook: async () => ({ id: 'event-discounted', type: 'checkout_completed', bookingId: accepted.id, sessionRef: `cs_${accepted.id}`, paymentRef: `pi_${accepted.id}`, paid: true, paymentStatus: 'paid', amountCaptured: reportedAmount, currency: 'eur' }),
      refund: async (paymentRef, amount) => { refunds.push({ paymentRef, amount }); return { refundRef: 're_discounted', amountMinor: amount }; },
    };
    const mismatch = await handlePaymentWebhook(request({}), context);
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({ error: { code: 'payment_amount_mismatch' } });
    expect((await context.repo.getBookingById(accepted.id))?.status).toBe('hold');
    reportedAmount = 9_000;
    expect((await handlePaymentWebhook(request({}), context)).status).toBe(200);
    const confirmed = await context.repo.getBookingById(accepted.id);
    if (!confirmed) throw new Error('Missing confirmed booking');
    expect(await store.bookingCounts(NOW)).toEqual({ ok: true, value: [{ partnerId: current.id, upcoming: 1, past: 0 }] });
    expect(await store.bookingCounts('2026-06-15T08:00:00.000Z')).toEqual({ ok: true, value: [{ partnerId: current.id, upcoming: 0, past: 1 }] });
    const moved = await handleCustomerReschedule(request({ token: confirmed.cancelToken, start: '2026-06-16T08:00:00.000Z' }), context);
    expect(moved.status).toBe(200);
    expect(await context.repo.getBookingById(accepted.id)).toMatchObject({ startsAt: '2026-06-16T08:00:00.000Z', priceMinor: 9_000, partnerPricing: reviewed.pricing, partnerAttribution: { name: current.name } });
    expect((await handleOperatorCancel(request({ operatorToken: confirmed.operatorToken, refund: 'full' }), context)).status).toBe(200);
    expect(refunds).toEqual([{ paymentRef: `pi_${accepted.id}`, amount: 9_000 }]);
    expect(await context.repo.getBookingById(accepted.id)).toMatchObject({ status: 'cancelled', priceMinor: 9_000, partnerPricing: reviewed.pricing, partnerAttribution: { name: current.name } });
  });

  it('supports the explicit legacy metadata bridge only while application is off', async () => {
    const current = await partner();
    const legacyService: ResolvedServiceConfig = { ...formula, metadataFields: [{ key: 'partner', label: 'Partner', type: 'select', visibility: 'operator', options: [{ value: current.code, label: current.name }] }] };
    const off = harness(false, legacyService);
    expect((await checkout(off.context, undefined, undefined, { metadata: { partner: current.code } })).status).toBe(201);
    expect(off.charges[0]).toMatchObject({ priceMinor: 12_000, partnerAttribution: { code: current.code } });
    const accepted = off.charges[0];
    if (!accepted) throw new Error('Missing legacy checkout');
    await off.context.repo.expireHold(accepted.id, NOW);
    const on = harness(true, legacyService);
    const blocked = await checkout(on.context, undefined, undefined, { metadata: { partner: current.code } });
    expect(blocked.status).toBe(400);
    // The field legacy clients retry on, so they book without the partner rather than fail.
    await expect(blocked.json()).resolves.toMatchObject({ error: { code: 'validation_failed', details: { field: 'metadata.partner' } } });
    expect(on.charges).toHaveLength(0);
  });

  it('keeps legacy attribution-only checkout bookable when the registry cannot be read', async () => {
    const current = await partner();
    const legacyService: ResolvedServiceConfig = { ...formula, metadataFields: [{ key: 'partner', label: 'Partner', type: 'select', visibility: 'operator', options: [{ value: current.code, label: current.name }] }] };
    const { context, charges } = harness(false, legacyService);
    context.partners = { ...store, findByCode: async () => ({ ok: false, error: new PartnerStoreError('unavailable', 'Database failed') }) };
    expect((await checkout(context, undefined, undefined, { metadata: { partner: current.code } })).status).toBe(201);
    expect(charges[0]).toMatchObject({ priceMinor: 12_000, partnerId: null, partnerAttribution: null, partnerPricing: null, metadata: null });
  });

  it('resolves the explicit legacy bridge against D1, not retired static select options, and strips unavailable claims', async () => {
    const current = await partner();
    const staleSelect: ResolvedServiceConfig = { ...formula, metadataFields: [{ key: 'partner', label: 'Partner', type: 'select', visibility: 'operator', options: [{ value: 'old-configuration-code', label: 'Old label' }] }] };
    const off = harness(false, staleSelect);
    expect((await checkout(off.context, undefined, undefined, { metadata: { partner: current.code } })).status).toBe(201);
    const accepted = off.charges[0];
    if (!accepted) throw new Error('Missing legacy checkout');
    expect(accepted).toMatchObject({ partnerAttribution: { code: current.code }, metadata: { partner: current.code } });
    await off.context.repo.expireHold(accepted.id, NOW);
    const bad = await checkout(off.context, undefined, undefined, { metadata: { partner: 'not/a/code' } });
    expect(bad.status).toBe(201);
    const stripped = off.charges.at(-1);
    if (!stripped) throw new Error('Missing malformed-claim checkout');
    expect(stripped).toMatchObject({ partnerId: null, partnerAttribution: null, metadata: null, priceMinor: 12_000 });
    await off.context.repo.expireHold(stripped.id, NOW);
    await save(current, { name: current.name, state: 'archived', offer: current.offer });
    expect((await checkout(off.context, undefined, undefined, { metadata: { partner: current.code } })).status).toBe(201);
    const archived = off.charges.at(-1);
    if (!archived) throw new Error('Missing archived-referral checkout');
    expect(archived).toMatchObject({ partnerId: null, partnerAttribution: null, metadata: null, priceMinor: 12_000 });
    await off.context.repo.expireHold(archived.id, NOW);
    const active = await partner();
    const retired = harness(false, formula);
    expect((await checkout(retired.context, undefined, undefined, { metadata: { partner: active.code } })).status).toBe(201);
    expect(retired.charges[0]).toMatchObject({ partnerAttribution: { code: active.code }, metadata: null });
  });

  it('prices services an offer can no longer be sold on normally, and asks for review of the change', async () => {
    const current = await partner();
    const tiers = harness(true, service);
    const tierQuote = await quote(tiers.context, current.code, { quantity: 4, pickup: 'custom' });
    expect(tierQuote).toMatchObject({ referral: { status: 'active', benefits: [] }, pricing: { savingsMinor: 0, appliedOffer: null } });
    const { context, charges } = harness();
    const reviewed = await quote(context, current.code);
    expect(reviewed.priceMinor).toBe(9_000);
    const noFloor = { ...context, partnerOffers: { enabled: true, minimumChargeMinorByCurrency: {} } };
    const unfloored = await checkout(noFloor, current.code, reviewed.quoteFingerprint);
    expect(unfloored.status).toBe(409);
    await expect(unfloored.json()).resolves.toMatchObject({ error: { code: 'quote_changed', details: { quote: { priceMinor: 12_000, referral: { status: 'active', benefits: [] } } } } });
    await save(current, { name: current.name, state: 'active', offer: { enabled: true, basisPoints: 10_000, waivedPickupIds: ['custom'] } });
    const free = await checkout(context, current.code, reviewed.quoteFingerprint);
    expect(free.status).toBe(409);
    await expect(free.json()).resolves.toMatchObject({ error: { code: 'quote_changed', details: { quote: { priceMinor: 12_000, pricing: { appliedOffer: null } } } } });
    expect(await holdCount()).toBe(0);
    expect(charges).toHaveLength(0);
  });

  it('rejects an unsellable party size as invalid input, not a changed quote', async () => {
    const current = await partner();
    const { context, charges } = harness();
    const reviewed = await quote(context, current.code);
    const response = await checkout(context, current.code, reviewed.quoteFingerprint, { quantity: 9 });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation_failed' } });
    expect(charges).toHaveLength(0);
  });
});
