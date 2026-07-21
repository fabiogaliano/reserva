import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = resolve(process.cwd(), 'scripts/bookkit-migrate.ts');
const fixtureDirectories: string[] = [];

function fixtureDirectory(): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'bookkit-migrate-'));
  fixtureDirectories.push(directory);
  const wranglerPath = resolve(directory, 'wrangler');
  writeFileSync(wranglerPath, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$BOOKKIT_MIGRATE_ARGS"\n');
  chmodSync(wranglerPath, 0o755);
  return directory;
}

function run(config: string, args: string[] = []) {
  const cwd = fixtureDirectory();
  const capturedArgsPath = resolve(cwd, 'wrangler-args.txt');
  writeFileSync(resolve(cwd, 'wrangler.jsonc'), config);
  const result = spawnSync('bun', [scriptPath, ...args], {
    cwd,
    env: {
      ...process.env,
      PATH: `${cwd}:${process.env.PATH ?? ''}`,
      BOOKKIT_MIGRATE_ARGS: capturedArgsPath,
    },
    encoding: 'utf8',
  });
  return {
    ...result,
    capturedArgs: () => readFileSync(capturedArgsPath, 'utf8').trim().split('\n'),
  };
}

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('bookkit-migrate CLI', () => {
  it('selects the BOOKKIT_DB binding when it is not the first database', () => {
    const result = run(`{
      "d1_databases": [
        { "binding": "ANALYTICS_DB", "database_name": "analytics" },
        { "binding": "BOOKKIT_DB", "database_name": "bookings" }
      ]
    }`, ['--local']);

    expect(result.status).toBe(0);
    expect(result.capturedArgs()).toContain('bookings');
    expect(result.capturedArgs()).not.toContain('analytics');
  });

  it('fails with all candidates when multiple databases lack the BOOKKIT_DB binding', () => {
    const result = run(`{
      "d1_databases": [
        { "binding": "ANALYTICS_DB", "database_name": "analytics" },
        { "binding": "OTHER_DB", "database_name": "other" }
      ]
    }`);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/multiple D1 databases.*analytics.*other.*bookkit-migrate <database_name> --local/s);
  });

  it('selects the sole database even when it has a custom binding', () => {
    const result = run('{ "d1_databases": [{ "binding": "CUSTOM_DB", "database_name": "bookings" }] }');

    expect(result.status).toBe(0);
    expect(result.capturedArgs()).toContain('bookings');
  });

  it('parses comment-like content inside JSON strings', () => {
    const result = run(`{
      "note": "a//b",
      "endpoint": "https://example.test/bookings",
      "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "bookings" }]
    }`);

    expect(result.status).toBe(0);
    expect(result.capturedArgs()).toContain('bookings');
  });

  it('rejects --config when its path argument is missing', () => {
    const result = run('{ "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "bookings" }] }', ['--config', '--local']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--config.*requires a path argument/);
  });

  it('uses an explicit database name in preference to configuration', () => {
    const result = run(`{
      "d1_databases": [
        { "binding": "ANALYTICS_DB", "database_name": "analytics" },
        { "binding": "OTHER_DB", "database_name": "other" }
      ]
    }`, ['chosen', '--local']);

    expect(result.status).toBe(0);
    expect(result.capturedArgs()).toContain('chosen');
  });
});
