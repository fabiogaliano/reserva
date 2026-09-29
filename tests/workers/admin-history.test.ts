import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBookingRepository, type AdminChangeAudit } from '../../src/repo';

interface TestEnv {
  RESERVA_DB: D1Database;
}

// Real-D1 coverage for admin_change_history: proves the change and its history row actually
// land together, and listAdminChangeHistory reads them back most-recent-first.
const db = (env as unknown as TestEnv).RESERVA_DB;
const repo = createBookingRepository(db);

beforeEach(async () => {
  await db.prepare('DELETE FROM settings').run();
  await db.prepare('DELETE FROM day_overrides').run();
  await db.prepare('DELETE FROM capacity_defaults').run();
  await db.prepare('DELETE FROM admin_change_history').run();
});

const AUDIT: AdminChangeAudit = { actor: 'ops@example.test', changedAt: '2026-09-01T12:00:00.000Z' };

// Written directly so the seed leaves no history row of its own for the assertions to discount.
const seedSetting = async (key: string, value: string) => {
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(key, value).run();
};

describe('applySettingsBatch + admin_change_history against real D1', () => {
  it('a mixed upsert+delete batch writes the settings rows AND their history rows in one call', async () => {
    await seedSetting('booking.holdMinutes', '45');

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
    await seedSetting('legal.termsUrl', '"https://example.test/terms"');
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

    expect(all.find((entry) => entry.domain === 'capacity_default' && entry.action === 'upsert')?.value)
      .toBe(JSON.stringify({ capacity: 3, reason: 'first' }));

    const limited = await repo.listAdminChangeHistory(2);
    expect(limited).toHaveLength(2);
    expect(limited).toEqual(all.slice(0, 2));
  });
});

describe('admin change + history atomicity against real D1', () => {
  afterEach(async () => {
    await db.prepare('DROP TRIGGER IF EXISTS fail_admin_history').run();
    await db.prepare('DROP TRIGGER IF EXISTS fail_admin_change').run();
  });

  const readSettings = () => repo.listSettings();
  const readDefaults = () => repo.listCapacityDefaults();
  const readOverrides = () => repo.listDayOverrides('2026-01-01', '2026-12-31');
  const seedDefault = async () => {
    await db.prepare("INSERT INTO capacity_defaults (from_date, capacity, reason) VALUES ('2026-09-01', 3, 'seeded')").run();
  };
  const seedOverrides = async () => {
    await db.prepare("INSERT INTO day_overrides (date, capacity, reason) VALUES ('2026-09-01', 2, 'seeded'), ('2026-09-02', 2, 'seeded')").run();
  };

  // Each trigger aborts on the family's LAST write, so a write family that committed its
  // statements one by one would leave the earlier change or history row behind. Failing the
  // change side as well as the history side covers either statement order.
  const families = [
    {
      name: 'applySettingsBatch',
      seed: () => seedSetting('booking.holdMinutes', '45'),
      act: () => repo.applySettingsBatch([
        { type: 'upsert', key: 'booking.minNoticeHours', value: '2' },
        { type: 'delete', key: 'booking.holdMinutes' },
      ], AUDIT),
      changeTrigger: "BEFORE DELETE ON settings WHEN OLD.key = 'booking.holdMinutes'",
      lastItemKey: 'booking.holdMinutes',
      read: readSettings,
    },
    {
      name: 'deleteSetting',
      seed: () => seedSetting('legal.termsUrl', '"https://example.test/terms"'),
      act: () => repo.deleteSetting('legal.termsUrl', AUDIT),
      changeTrigger: 'BEFORE DELETE ON settings',
      lastItemKey: 'legal.termsUrl',
      read: readSettings,
    },
    {
      name: 'upsertCapacityDefault',
      seed: seedDefault,
      act: () => repo.upsertCapacityDefault('2026-09-01', 5, 'changed', AUDIT),
      changeTrigger: 'BEFORE INSERT ON capacity_defaults',
      lastItemKey: '2026-09-01',
      read: readDefaults,
    },
    {
      name: 'deleteCapacityDefault',
      seed: seedDefault,
      act: () => repo.deleteCapacityDefault('2026-09-01', AUDIT),
      changeTrigger: 'BEFORE DELETE ON capacity_defaults',
      lastItemKey: '2026-09-01',
      read: readDefaults,
    },
    {
      name: 'upsertDayOverrides',
      seed: seedOverrides,
      act: () => repo.upsertDayOverrides(['2026-09-01', '2026-09-02'], 0, 'closed', AUDIT),
      changeTrigger: "BEFORE INSERT ON day_overrides WHEN NEW.date = '2026-09-02'",
      lastItemKey: '2026-09-02',
      read: readOverrides,
    },
    {
      name: 'deleteDayOverrides',
      seed: seedOverrides,
      act: () => repo.deleteDayOverrides(['2026-09-01', '2026-09-02'], AUDIT),
      changeTrigger: "BEFORE DELETE ON day_overrides WHEN OLD.date = '2026-09-02'",
      lastItemKey: '2026-09-02',
      read: readOverrides,
    },
  ];

  it.each(families)('$name leaves the change unapplied when its history insert fails', async ({ seed, act, lastItemKey, read }) => {
    await seed();
    const before = await read();
    await db.prepare(`CREATE TRIGGER fail_admin_history BEFORE INSERT ON admin_change_history
      WHEN NEW.item_key = '${lastItemKey}'
      BEGIN SELECT RAISE(ABORT, 'history insert failed'); END`).run();

    await expect(act()).rejects.toThrow('history insert failed');
    await expect(read()).resolves.toEqual(before);
    await expect(repo.listAdminChangeHistory(10)).resolves.toEqual([]);
  });

  it.each(families)('$name records no history when its change fails', async ({ seed, act, changeTrigger, read }) => {
    await seed();
    const before = await read();
    await db.prepare(`CREATE TRIGGER fail_admin_change ${changeTrigger}
      BEGIN SELECT RAISE(ABORT, 'change failed'); END`).run();

    await expect(act()).rejects.toThrow('change failed');
    await expect(read()).resolves.toEqual(before);
    await expect(repo.listAdminChangeHistory(10)).resolves.toEqual([]);
  });

  it('an empty settings batch or empty date list records no history', async () => {
    await repo.applySettingsBatch([], AUDIT);
    await repo.upsertDayOverrides([], 9, 'should never land', AUDIT);
    await repo.deleteDayOverrides([], AUDIT);
    await expect(repo.listAdminChangeHistory(10)).resolves.toEqual([]);
  });
});
