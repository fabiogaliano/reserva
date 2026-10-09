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
  return { action: 'partner-create', code, name: 'Admin partner', percentage: '10.25', offer_enabled: 'on', waived_pickup: 'custom' };
}

// The visible text of a page, so assertions read like what the operator sees.
function text(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
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
    const created = destination(await post(ctx, input));
    expect(created.searchParams.get('saved')).toBe('created');
    const saved = await read(input.code);
    // A new partner opens on its own page, where its link is.
    expect(created.searchParams.get('partner')).toBe(saved.id);
    expect(saved.offer).toEqual({ enabled: true, basisPoints: 1_025, waivedPickupIds: ['custom'] });
    expect(await history(saved.id)).toMatchObject([{ actor: 'partner-admin', domain: 'partner' }]);
    expect(rebuilds).toEqual([]);
    const response = await handleAdminGet(new Request(created), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    const html = await response.text();
    expect(text(html)).toContain("Offers aren't live yet");
    expect(text(html)).toContain('Partner added. Send them the link below.');
    expect(html).toContain('value="10.25"');
    expect(html).toContain('name="csrf_token"');
    expect(html).toContain(`data-reserva-copy="https://example.test/?ref=${input.code}"`);
    expect(text(html)).toContain("Codes can't be changed or reused.");
    expect(html).toContain('value="partner-archive"');
    // Only a pickup that costs something can be made free.
    expect(html).toContain('name="waived_pickup" value="custom" checked');
    expect(html).not.toContain('name="waived_pickup" value="default"');
    // The preview prices the smallest booking: 100.00 less 10.25%, and the free hotel pickup.
    expect(text(html)).toContain('€100.00 €89.75');
    expect(text(html)).toContain('€120.00 €89.75');
  });

  it('allows partners without offers and archives/reactivates independently of the offer switch', async () => {
    const { ctx } = context();
    const input = { ...creation(), percentage: '0', offer_enabled: '', waived_pickup: '' };
    const fields = { action: input.action, code: input.code, name: input.name, percentage: input.percentage };
    destination(await post(ctx, fields));
    const saved = await read(input.code);
    expect(saved.offer).toBeNull();
    destination(await post(ctx, { action: 'partner-archive', code: saved.code, partner_id: saved.id, revision: '1' }));
    expect((await read(input.code)).state).toBe('archived');
    // Saving an archived partner's details leaves it archived; only restoring brings it back.
    destination(await post(ctx, { action: 'partner-save', code: saved.code, partner_id: saved.id, revision: '2', name: 'Renamed', percentage: '10' }));
    expect(await read(input.code)).toMatchObject({ revision: 3, state: 'archived', name: 'Renamed', offer: { enabled: false, basisPoints: 1_000, waivedPickupIds: [] } });
    expect(destination(await post(ctx, { action: 'partner-restore', code: saved.code, partner_id: saved.id, revision: '3' })).searchParams.get('saved')).toBe('restore');
    expect(await read(input.code)).toMatchObject({ revision: 4, state: 'active', name: 'Renamed', offer: { enabled: false, basisPoints: 1_000, waivedPickupIds: [] } });
  });

  it('rejects duplicate/reserved codes and stale writes without touching records/audit', async () => {
    const { ctx } = context();
    const input = creation();
    destination(await post(ctx, input));
    const saved = await read(input.code);
    const taken = destination(await post(ctx, { ...input, name: 'Second partner' }));
    expect(taken.searchParams.get('error')).toBe('partner_conflict');
    expect(taken.searchParams.get('field')).toBe('code');
    // The add form comes back with what was typed, and says why the code was refused.
    const retry = await (await handleAdminGet(new Request(taken), ctx)).text();
    expect(retry).toContain('value="Second partner"');
    expect(text(retry)).toContain('That code is in use, or was used by a partner before. Choose another.');
    const changes = { action: 'partner-save', code: saved.code, partner_id: saved.id, revision: '1', name: 'New name', percentage: '5' };
    destination(await post(ctx, changes));
    expect(destination(await post(ctx, { ...changes, name: 'Stale name' })).searchParams.get('error')).toBe('partner_conflict');
    expect((await read(input.code)).name).toBe('New name');
    expect(await history(saved.id)).toHaveLength(2);
    const page = await handleAdminGet(new Request(`https://example.test/booking/admin?view=partners&partner=${saved.id}&error=partner_conflict`), ctx);
    expect(text(await page.text())).toContain('Reload it and make your change again.');
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
    // The refusal says which tour, at what price, and how far the discount can go: 50% leaves
    // the €1 tour at exactly the €0.50 minimum.
    const refused = await (await handleAdminGet(new Request(location), cheap)).text();
    expect(text(refused)).toContain('With this offer, Vintage Tour would cost €0.25, below the minimum payment of €0.50. Use 50% at most.');
    expect(refused).toContain('value="75"');
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
    expect(refused.searchParams.get('reason')).toBe('payment_floor');
    // Earlier tests share this database, so the partner named is whichever offer breaks first.
    const blocked = refused.searchParams.get('partner') ?? '';
    const page = await (await handleAdminGet(new Request(refused), ctx)).text();
    expect(text(page)).toMatch(/With this change, the offer of partner .+ would take a tour below the minimum payment\./);
    expect(page).toContain(`href="/booking/admin?view=partners&amp;partner=${blocked}"`);
    // An offer a deployment's higher minimum already took out of scope does not block unrelated edits.
    expect(destination(await reset(20_000)).searchParams.get('saved')).toBe('1');
  });

  it('names the services a saved offer no longer applies to', async () => {
    const { ctx } = context();
    const input = creation();
    destination(await post(ctx, input));
    const raised = { ...ctx, partnerOffers: { enabled: true, minimumChargeMinorByCurrency: { eur: 20_000 } } };
    const html = await (await handleAdminGet(new Request('https://example.test/booking/admin?view=partners'), raised)).text();
    expect(text(html)).toContain(`Normal price on ${service.title}: the offer can't apply there.`);
    expect(text(await (await handleAdminGet(new Request('https://example.test/booking/admin?view=partners'), ctx)).text())).not.toContain('Normal price on');
  });

  it('describes what each partner change did in the history, linking to the partner', async () => {
    const { ctx } = context();
    const input = creation();
    destination(await post(ctx, input));
    const saved = await read(input.code);
    destination(await post(ctx, { ...input, action: 'partner-save', partner_id: saved.id, revision: '1', name: 'Renamed partner' }));
    const edit = { action: 'partner-save', code: saved.code, partner_id: saved.id, name: 'Renamed partner', percentage: '15' };
    destination(await post(ctx, { ...edit, revision: '2', offer_enabled: 'on' }));
    destination(await post(ctx, { ...edit, revision: '3' }));
    destination(await post(ctx, { action: 'partner-archive', code: saved.code, partner_id: saved.id, revision: '4' }));
    const html = await (await handleAdminGet(new Request('https://example.test/booking/admin?view=settings&section=history'), ctx)).text();
    const page = text(html);
    expect(page).toContain('Partner Admin partner added with an offer: 10.25% off · Hotel pickup free of charge');
    expect(page).toContain('Partner Admin partner renamed to Renamed partner');
    expect(page).toContain('Partner Renamed partner: offer changed to 15% off');
    expect(page).toContain('Partner Renamed partner: offer paused');
    expect(page).toContain('Partner Renamed partner archived');
    expect(html).toContain(`<a href="/booking/admin?view=partners&amp;partner=${saved.id}">Renamed partner</a>`);
  });

  it('accepts a decimal comma, the way Portuguese is typed', async () => {
    const { ctx } = context();
    const input = { ...creation(), percentage: '12,5' };
    destination(await post(ctx, input));
    expect((await read(input.code)).offer?.basisPoints).toBe(1_250);
  });
});
