import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBookingRepository, type AdminChangeAudit } from '../../src/repo';

interface TestEnv {
  BOOKKIT_DB: D1Database;
}

// Plan 005: real-D1 coverage for admin_change_history, the durable actor-attributed record every
// settings/capacity write produces atomically with the change itself. tests/repo.test.ts proves the
// mechanism (exactly one db.batch() call per mutating method, structurally, against a counting
// fake); this proves the mechanism's real-D1 effect — the change and its history rows actually land
// together, and listAdminChangeHistory reads them back most-recent-first.
const db = (env as unknown as TestEnv).BOOKKIT_DB;
const repo = createBookingRepository(db);

beforeEach(async () => {
  await db.prepare('DELETE FROM settings').run();
  await db.prepare('DELETE FROM day_overrides').run();
  await db.prepare('DELETE FROM capacity_defaults').run();
  await db.prepare('DELETE FROM admin_change_history').run();
});

const AUDIT: AdminChangeAudit = { actor: 'ops@example.test', changedAt: '2026-09-01T12:00:00.000Z' };

describe('applySettingsBatch + admin_change_history against real D1', () => {
  it('a mixed upsert+delete batch writes the settings rows AND their history rows in one call', async () => {
    await repo.upsertSetting('booking.holdMinutes', '45');

    await repo.applySettingsBatch([
      { type: 'upsert', key: 'booking.minNoticeHours', value: '2' },
      { type: 'upsert', key: 'booking.maxHorizonDays', value: '90' },
      { type: 'delete', key: 'booking.holdMinutes' },
    ], AUDIT);

    const settings = await repo.listSettings();
    expect(settings).toEqual({ 'booking.minNoticeHours': '2', 'booking.maxHorizonDays': '90' });

    const history = await repo.listAdminChangeHistory(10);
    expect(history).toHaveLength(3);
    expect(history.every((entry) => entry.domain === 'setting' && entry.actor === AUDIT.actor && entry.changedAt === AUDIT.changedAt)).toBe(true);
    const byKey = Object.fromEntries(history.map((entry) => [entry.itemKey, entry]));
    expect(byKey['booking.minNoticeHours']).toMatchObject({ action: 'upsert', value: '2' });
    expect(byKey['booking.maxHorizonDays']).toMatchObject({ action: 'upsert', value: '90' });
    expect(byKey['booking.holdMinutes']).toMatchObject({ action: 'delete', value: null });
  });

  it('deleteSetting writes exactly one history row for the key it removed', async () => {
    await repo.upsertSetting('legal.termsUrl', '"https://example.test/terms"');
    await repo.deleteSetting('legal.termsUrl', AUDIT);

    const history = await repo.listAdminChangeHistory(10);
    expect(history).toEqual([
      expect.objectContaining({ domain: 'setting', itemKey: 'legal.termsUrl', action: 'delete', value: null, actor: AUDIT.actor }),
    ]);
  });

  it('an actor of null (anonymous admin identity) is stored and read back as null, not the empty string', async () => {
    await repo.applySettingsBatch([{ type: 'upsert', key: 'booking.minNoticeHours', value: '3' }], { actor: null, changedAt: AUDIT.changedAt });

    const history = await repo.listAdminChangeHistory(10);
    expect(history).toHaveLength(1);
    expect(history[0]?.actor).toBeNull();
  });
});

describe('listAdminChangeHistory ordering against real D1', () => {
  it('returns rows most-recent-first (ORDER BY id DESC) across mixed domains, and respects the limit', async () => {
    await repo.applySettingsBatch([{ type: 'upsert', key: 'booking.minNoticeHours', value: '1' }], AUDIT);
    await repo.upsertCapacityDefault('2026-09-01', 3, 'first', AUDIT);
    await repo.upsertDayOverrides(['2026-09-05'], 0, 'second', AUDIT);
    await repo.deleteCapacityDefault('2026-09-01', AUDIT);

    const all = await repo.listAdminChangeHistory(10);
    expect(all.map((entry) => [entry.domain, entry.action])).toEqual([
      ['capacity_default', 'delete'],
      ['day_override', 'upsert'],
      ['capacity_default', 'upsert'],
      ['setting', 'upsert'],
    ]);
    // ids strictly increase with insertion order, so DESC really is most-recent-first, not an
    // accidental match on a stable sort of ties.
    expect(all.map((entry) => entry.id)).toEqual([...all.map((entry) => entry.id)].sort((a, b) => b - a));

    const limited = await repo.listAdminChangeHistory(2);
    expect(limited).toHaveLength(2);
    expect(limited).toEqual(all.slice(0, 2));
  });
});
