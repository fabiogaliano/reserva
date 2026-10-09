import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { createPartnerStore, parseReferralCode, type PartnerRecord, type PartnerStoreResult } from '../../src/partners';
import type { PartnerOffer } from '../../src/core/partner-offers';
import { createBookingRepository } from '../../src/repo';

// SAFETY: wrangler.test.jsonc binds RESERVA_DB to D1 in the Workers test project.
const db = (env as unknown as { RESERVA_DB: D1Database }).RESERVA_DB;
const store = createPartnerStore(db);
const audit = { actor: 'operator@example.test', changedAt: '2026-09-01T12:00:00.000Z' };
const offer: PartnerOffer = { enabled: false, basisPoints: 1_025, waivedPickupIds: ['custom'] };

function unwrap<T>(result: PartnerStoreResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

async function create(withOffer: PartnerOffer | null = offer): Promise<PartnerRecord> {
  const id = crypto.randomUUID();
  return unwrap(await store.create({ id, code: `partner-${id}`, changes: { name: 'Partner name', state: 'active', offer: withOffer } }, audit));
}

async function history(id: string) {
  return db.prepare("SELECT * FROM admin_change_history WHERE domain = 'partner' AND item_key = ? ORDER BY id").bind(id).all();
}

afterEach(async () => {
  await db.prepare('DROP TRIGGER IF EXISTS fail_partner_audit').run();
  await db.prepare('DROP TRIGGER IF EXISTS fail_partner_offer').run();
});

describe('partner registry against real D1', () => {
  it('creates partners without an offer and reads single codes exactly', async () => {
    const partner = await create(null);
    expect(partner).toMatchObject({ revision: 1, state: 'active', name: 'Partner name', offer: null, createdAt: audit.changedAt, updatedAt: audit.changedAt });
    expect(unwrap(await store.findByCode(partner.code))).toEqual(partner);
    expect(unwrap(await store.findByCode('unknown-partner'))).toBeNull();
    expect(unwrap(await store.list())).toContainEqual(partner);
  });

  it('keeps codes reserved after archive and allows reactivation without enabling benefits', async () => {
    const partner = await create();
    const archived = unwrap(await store.save(partner.id, partner.revision, { name: 'Renamed', state: 'archived', offer }, audit));
    expect(archived).toMatchObject({ code: partner.code, revision: 2, name: 'Renamed', state: 'archived', offer });
    const duplicate = await store.create({ id: crypto.randomUUID(), code: partner.code, changes: { name: 'Another partner', state: 'active', offer: null } }, audit);
    expect(duplicate).toMatchObject({ ok: false, error: { reason: 'conflict' } });
    const active = unwrap(await store.save(partner.id, 2, { name: 'Renamed', state: 'active', offer }, audit));
    expect(active).toMatchObject({ revision: 3, state: 'active', offer: { enabled: false, basisPoints: 1_025 } });
    expect((await history(partner.id)).results).toHaveLength(3);
  });

  it('saves offer, partner revision and audit together and rejects stale writes without changing any of them', async () => {
    const partner = await create();
    const updated = unwrap(await store.save(partner.id, 1, { name: 'New name', state: 'active', offer: { ...offer, enabled: true } }, { ...audit, actor: 'second-operator' }));
    const stale = await store.save(partner.id, 1, { name: 'Stale name', state: 'archived', offer: null }, audit);
    expect(stale).toMatchObject({ ok: false, error: { reason: 'conflict' } });
    expect(unwrap(await store.findByCode(partner.code))).toEqual(updated);
    const rows = (await history(partner.id)).results;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ actor: 'second-operator', value: JSON.stringify({ name: 'New name', state: 'active', offer: { ...offer, enabled: true } }) });
    expect(await db.prepare('SELECT revision FROM partner_offers WHERE partner_id = ?').bind(partner.id).first()).toEqual({ revision: 2 });
    expect((await createBookingRepository(db).listAdminChangeHistory(100)).find((row) => row.itemKey === partner.id)).toMatchObject({ domain: 'partner' });
  });

  it('allows clearing and recreating the optional current offer', async () => {
    const partner = await create();
    const cleared = unwrap(await store.save(partner.id, 1, { name: partner.name, state: 'active', offer: null }, audit));
    expect(cleared.offer).toBeNull();
    expect(await db.prepare('SELECT * FROM partner_offers WHERE partner_id = ?').bind(partner.id).first()).toBeNull();
    const restored = unwrap(await store.save(partner.id, 2, { name: partner.name, state: 'active', offer }, audit));
    expect(restored).toMatchObject({ revision: 3, offer });
  });

  it('has exactly one winner for simultaneous edits against the same revision', async () => {
    const partner = await create();
    const results = await Promise.all([
      store.save(partner.id, 1, { name: 'A', state: 'active', offer: null }, audit),
      store.save(partner.id, 1, { name: 'B', state: 'active', offer: { ...offer, enabled: true } }, audit),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([{ ok: false, error: { reason: 'conflict' } }]);
    expect((await history(partner.id)).results).toHaveLength(2);
    const winner = results.find((result) => result.ok);
    if (!winner?.ok) throw new Error('Missing winning edit');
    expect(unwrap(await store.findByCode(partner.code))).toEqual(winner.value);
  });

  it('rolls back partner and offer when audit insert fails', async () => {
    const partner = await create();
    await db.prepare("CREATE TRIGGER fail_partner_audit BEFORE INSERT ON admin_change_history WHEN NEW.domain = 'partner' BEGIN SELECT RAISE(ABORT, 'test failure'); END").run();
    expect(await store.save(partner.id, 1, { name: 'Not saved', state: 'archived', offer: null }, audit)).toMatchObject({ ok: false, error: { reason: 'unavailable' } });
    expect(unwrap(await store.findByCode(partner.code))).toEqual(partner);
    expect((await history(partner.id)).results).toHaveLength(1);
  });

  it('rolls back partner and audit when an offer write fails', async () => {
    const partner = await create();
    await db.prepare("CREATE TRIGGER fail_partner_offer BEFORE UPDATE ON partner_offers BEGIN SELECT RAISE(ABORT, 'test failure'); END").run();
    expect(await store.save(partner.id, 1, { name: 'Not saved', state: 'archived', offer: { ...offer, enabled: true } }, audit)).toMatchObject({ ok: false, error: { reason: 'unavailable' } });
    expect(unwrap(await store.findByCode(partner.code))).toEqual(partner);
    expect((await history(partner.id)).results).toHaveLength(1);
  });

  it('protects immutable/reserved codes at the database boundary too', async () => {
    const partner = await create();
    await expect(db.prepare('UPDATE partners SET code = ? WHERE id = ?').bind('replacement', partner.id).run()).rejects.toThrow('immutable');
    await expect(db.prepare('DELETE FROM partners WHERE id = ?').bind(partner.id).run()).rejects.toThrow('Archive partners');
  });

  it('rejects invalid input before writing and does not disclose valid codes', async () => {
    for (const code of ['', 'UPPERCASE', 'a/b', 'a b', '-prefix', 'x'.repeat(65)]) {
      expect(parseReferralCode(code)).toMatchObject({ ok: false, error: { reason: 'invalid_input' } });
    }
    const id = crypto.randomUUID();
    const result = await store.create({ id, code: 'valid', changes: { name: ' ', state: 'active', offer: null } }, audit);
    expect(result).toMatchObject({ ok: false, error: { reason: 'invalid_input' } });
    expect(await db.prepare('SELECT * FROM partners WHERE id = ?').bind(id).first()).toBeNull();
    expect((await history(id)).results).toHaveLength(0);
  });

  it('fails closed on a corrupt stored offer instead of resolving it without benefits', async () => {
    const partner = await create();
    await db.prepare("UPDATE partner_offers SET waived_pickup_ids = '[1]' WHERE partner_id = ?").bind(partner.id).run();
    expect(await store.findByCode(partner.code)).toMatchObject({ ok: false, error: { reason: 'unavailable' } });
  });
});
