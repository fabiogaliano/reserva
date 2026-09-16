import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSchemaFingerprint } from '../scripts/generate-schema-fingerprint';
import { RESERVA_MIGRATIONS, RESERVA_SCHEMA_TABLES } from '../src/generated/schema-fingerprint';

const migrationsDir = resolve(import.meta.dirname, '../migrations');

describe('generated schema fingerprint', () => {
  it('lists migrations/*.sql on disk exactly, in filename order', () => {
    const onDisk = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));
    expect([...RESERVA_MIGRATIONS]).toEqual(onDisk);
  });

  it('matches a fresh replay of the migration chain, so a stale generated file fails the build', () => {
    const fingerprint = buildSchemaFingerprint(migrationsDir);
    expect(fingerprint.migrations).toEqual([...RESERVA_MIGRATIONS]);
    expect(fingerprint.tables).toEqual(JSON.parse(JSON.stringify(RESERVA_SCHEMA_TABLES)));
  });

  it('picks up a column added by a later migration', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'reserva-fingerprint-'));
    for (const name of RESERVA_MIGRATIONS) {
      writeFileSync(resolve(directory, name), readFileSync(resolve(migrationsDir, name), 'utf8'));
    }
    const before = buildSchemaFingerprint(directory);
    expect(before.tables.bookings?.columns).not.toContain('seat_preference');

    writeFileSync(resolve(directory, '9999_add_column.sql'), 'ALTER TABLE bookings ADD COLUMN seat_preference TEXT;\n');
    const after = buildSchemaFingerprint(directory);
    expect(after.migrations).toEqual([...RESERVA_MIGRATIONS, '9999_add_column.sql']);
    expect(after.tables.bookings?.columns).toContain('seat_preference');
  });
});
