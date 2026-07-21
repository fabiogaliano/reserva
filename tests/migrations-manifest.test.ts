import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOOKKIT_MIGRATIONS } from '../src/migrations-manifest';

describe('BOOKKIT_MIGRATIONS manifest', () => {
  it('matches migrations/*.sql on disk exactly, in filename order', () => {
    const migrationsDir = resolve(import.meta.dirname, '../migrations');
    const onDisk = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort((a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]));
    expect([...BOOKKIT_MIGRATIONS]).toEqual(onDisk);
  });
});
