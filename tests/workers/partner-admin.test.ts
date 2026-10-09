import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { mintAdminCsrfToken } from '../../src/admin-csrf';
import { createReservaContext, type ReservaContext } from '../../src/context';
import type { ResolvedServiceConfig } from '../../src/core/config';
import { handleAdminGet, handleAdminPost } from '../../src/handlers';
import { createPartnerStore } from '../../src/partners';
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
const formula: ResolvedServiceConfig = { ...service, pricing: { baseMinor: 10_000, surcharges: { default: 0, custom: 2_000 }, maxUnits: 2, seatsPerUnit: 4, surchargeScope: 'booking', inherited: { surcharges: false, maxUnits: false, surchargeScope: false } } };

function context(selected = formula) {
  const rebuilds: unknown[] = [];
  const ctx = createReservaContext({
    config: { ...config, services: { vintage: selected } }, db, providers: providers(),
    clock: () => new Date(NOW), adminAuth: async () => ({ subject: 'partner-admin' }),
    secrets: (name) => name === 'RESERVA_CSRF_SECRET' ? 'partner-admin-test-csrf-secret' : undefined,
    partnerOffers: { enabled: false, minimumChargeMinorByCurrency: { eur: 50 } },
    hooks: [{ name: 'rebuild-test', events: ['settings.changed'], handler: async (...args) => { rebuilds.push(args[0]); } }],
  });
  return { ctx, rebuilds };
}

async function post(ctx: ReservaContext, fields: Record<string, string> | Array<[string, string]>, options: { origin?: string; csrf?: string } = {}) {
  const token = await mintAdminCsrfToken(ctx, 'partner-admin', ctx.clock().getTime());
  if (!token) throw new Error('Missing test CSRF token');
  const body = new URLSearchParams(fields);
  body.set('csrf_token', options.csrf ?? token);
  return handleAdminPost(new Request('https://example.test/booking/admin?view=partners', {
    method: 'POST', body, headers: { origin: options.origin ?? 'https://example.test' },
  }), ctx);
}

function creation(code = `partner-${crypto.randomUUID()}`) {
  return { action: 'partner-create', code, name: 'Admin partner', state: 'active', percentage: '10.25', offer_enabled: 'on', waived_pickup: 'custom' };
}

function destination(response: Response): URL {
  expect(response.status).toBe(303);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const location = response.headers.get('location');
  if (!location) throw new Error('Missing admin redirect');
  return new URL(location);
}

async function read(code: string) {
  const result = await store.findByCode(code);
  if (!result.ok || !result.value) throw new Error('Missing saved partner');
  return result.value;
}

async function history(id: string) {
  return (await db.prepare("SELECT * FROM admin_change_history WHERE domain = 'partner' AND item_key = ?").bind(id).all()).results;
}

describe('authenticated partner admin through real D1', () => {
  it('creates combined decimal offers, labels configured pickups, audits the save and emits no rebuild event', async () => {
    const { ctx, rebuilds } = context();
    const input = creation();
    expect(destination(await post(ctx, input)).searchParams.get('saved')).toBe('1');
    const saved = await read(input.code);
    expect(saved.offer).toEqual({ enabled: true, basisPoints: 1_025, waivedPickupIds: ['custom'] });
    expect(await history(saved.id)).toMatchObject([{ actor: 'partner-admin', domain: 'partner' }]);
    expect(rebuilds).toEqual([]);
    const response = await handleAdminGet(new Request(`https://example.test/booking/admin?view=partners&partner=${saved.id}`), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    const html = await response.text();
    expect(html).toContain('Offer application is globally off');
    expect(html).toContain('Hotel pickup');
    expect(html).toContain('value="10.25"');
    expect(html).toContain('name="csrf_token"');
    expect(html).toContain(`data-reserva-copy="https://example.test/?ref=${input.code}"`);
    expect(html).toContain('Codes cannot be changed or reused');
    expect(html).toContain('formnovalidate');
  });

  it('allows partners without offers and archives/reactivates independently of the offer switch', async () => {
    const { ctx } = context();
    const input = { ...creation(), percentage: '0', offer_enabled: '', waived_pickup: '' };
    const fields = { action: input.action, code: input.code, name: input.name, state: input.state, percentage: input.percentage };
    destination(await post(ctx, fields));
    const saved = await read(input.code);
    expect(saved.offer).toBeNull();
    destination(await post(ctx, { action: 'partner-archive', code: saved.code, partner_id: saved.id, revision: '1' }));
    expect((await read(input.code)).state).toBe('archived');
    destination(await post(ctx, { action: 'partner-save', code: saved.code, partner_id: saved.id, revision: '2', name: 'Reactivated', state: 'active', percentage: '10' }));
    expect(await read(input.code)).toMatchObject({ revision: 3, state: 'active', name: 'Reactivated', offer: { enabled: false, basisPoints: 1_000, waivedPickupIds: [] } });
  });

  it('rejects duplicate/reserved codes and stale writes without touching records/audit', async () => {
    const { ctx } = context();
    const input = creation();
    destination(await post(ctx, input));
    const saved = await read(input.code);
    expect(destination(await post(ctx, input)).searchParams.get('error')).toBe('partner_conflict');
    const changes = { action: 'partner-save', code: saved.code, partner_id: saved.id, revision: '1', name: 'New name', state: 'active', percentage: '5' };
    destination(await post(ctx, changes));
    expect(destination(await post(ctx, { ...changes, name: 'Stale name' })).searchParams.get('error')).toBe('partner_conflict');
    expect((await read(input.code)).name).toBe('New name');
    expect(await history(saved.id)).toHaveLength(2);
    const page = await handleAdminGet(new Request(`https://example.test/booking/admin?view=partners&partner=${saved.id}&error=partner_conflict`), ctx);
    expect(await page.text()).toContain('Reload and review before saving');
  });

  it('rejects unauthorized, cross-origin and invalid-CSRF mutations before any record or audit write', async () => {
    const { ctx } = context();
    const input = creation();
    const unauthorized = { ...ctx, adminAuth: async () => null };
    expect((await handleAdminGet(new Request('https://example.test/booking/admin?view=partners'), unauthorized)).status).toBe(403);
    expect((await post(unauthorized, input)).status).toBe(403);
    expect((await post(ctx, input, { origin: 'https://attacker.test' })).status).toBe(403);
    expect(destination(await post(ctx, input, { csrf: 'forged-token' })).searchParams.get('error')).toBe('csrf_expired');
    const result = await store.findByCode(input.code);
    expect(result).toEqual({ ok: true, value: null });
  });

  it('rejects unknown pickup IDs, unsupported tier services and invalid percentages with actionable fields', async () => {
    const { ctx } = context();
    const cases = [
      { input: { ...creation(), waived_pickup: 'unknown' }, ctx, field: 'offer.pickup' },
      { input: { ...creation(), percentage: '10.001' }, ctx, field: 'percentage' },
      { input: creation(), ctx: context(service).ctx, field: 'offer.pricing' },
    ];
    for (const test of cases) {
      const redirect = destination(await post(test.ctx, test.input));
      expect(redirect.searchParams.get('error')).toBe('validation_failed');
      expect(redirect.searchParams.get('field')).toBe(test.field);
      expect(await store.findByCode(test.input.code)).toEqual({ ok: true, value: null });
    }
  });

  it('validates currency floors across all sold tours, including a €1 test tour while application is off', async () => {
    const { ctx } = context();
    const cheap = { ...ctx, config: { ...ctx.config, services: { ...ctx.config.services, test: { ...formula, pricing: { baseMinor: 100, surcharges: { default: 0, custom: 0 }, maxUnits: 1, seatsPerUnit: 4, surchargeScope: 'booking' as const, inherited: { surcharges: false, maxUnits: false, surchargeScope: false } } } } } };
    const input = { ...creation(), percentage: '75' };
    const location = destination(await post(cheap, input));
    expect(location.searchParams.get('field')).toBe('offer.payment_floor');
    const noMinimum = { ...ctx, partnerOffers: { enabled: false, minimumChargeMinorByCurrency: {} } };
    expect(destination(await post(noMinimum, creation())).searchParams.get('field')).toBe('offer.payment_floor');
    expect(await store.findByCode(input.code)).toEqual({ ok: true, value: null });
  });

  it('escapes operator labels and provides Portuguese labels without any customer-side UI changes', async () => {
    const { ctx } = context();
    const input = { ...creation(), name: '<script>malicious()</script>' };
    destination(await post(ctx, input));
    const saved = await read(input.code);
    const portuguese = { ...ctx, config: { ...ctx.config, admin: { ...ctx.config.admin, locale: 'pt-PT' } } };
    const page = await handleAdminGet(new Request(`https://example.test/booking/admin?view=partners&partner=${saved.id}`), portuguese);
    const html = await page.text();
    expect(html).toContain('Parceiros');
    expect(html).toContain('Arquivar parceiro');
    expect(html).toContain('&lt;script&gt;malicious()&lt;/script&gt;');
    expect(html).not.toContain('<script>malicious()');
  });
  it('refuses a settings change that would take a saved offer below the payment minimum', async () => {
    const { ctx } = context();
    const input = creation();
    destination(await post(ctx, input));
    const cheapFile = { ...ctx.config, services: { vintage: { ...formula, pricing: { ...formula.pricing, baseMinor: 50 } } } };
    const reset = (minimum: number) => post({ ...ctx, baseConfig: cheapFile, partnerOffers: { enabled: false, minimumChargeMinorByCurrency: { eur: minimum } } }, { action: 'settings-reset:services.vintage.pricing.baseMinor' });
    const refused = destination(await reset(50));
    expect(refused.searchParams.get('error')).toBe('validation_failed');
    expect(refused.searchParams.get('field')).toBe('partner_offers');
    const page = await handleAdminGet(new Request(`https://example.test/booking/admin?view=settings&section=pricing&error=validation_failed&field=partner_offers`), ctx);
    expect(await page.text()).toContain('Edit the offer on the Partners page first');
    // An offer a deployment's higher minimum already took out of scope does not block unrelated edits.
    expect(destination(await reset(20_000)).searchParams.get('saved')).toBe('1');
  });

  it('names the services a saved offer no longer applies to', async () => {
    const { ctx } = context();
    const input = creation();
    destination(await post(ctx, input));
    const raised = { ...ctx, partnerOffers: { enabled: true, minimumChargeMinorByCurrency: { eur: 20_000 } } };
    const html = await (await handleAdminGet(new Request('https://example.test/booking/admin?view=partners'), raised)).text();
    expect(html).toContain(`Not applied to: ${service.title}`);
    expect(await (await handleAdminGet(new Request('https://example.test/booking/admin?view=partners'), ctx)).text()).not.toContain('Not applied to');
  });

  it('labels partner history with the name and code, telling creation from edits', async () => {
    const { ctx } = context();
    const input = creation();
    destination(await post(ctx, input));
    const saved = await read(input.code);
    destination(await post(ctx, { ...input, action: 'partner-save', partner_id: saved.id, revision: String(saved.revision), name: 'Renamed partner' }));
    const html = await (await handleAdminGet(new Request('https://example.test/booking/admin?view=settings&section=history'), ctx)).text();
    expect(html).toContain(`Created partner Admin partner (${input.code})`);
    expect(html).toContain(`Updated partner Renamed partner (${input.code})`);
  });
});
