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

  it('parses trailing commas separated from their closing bracket by comments', () => {
    const result = run(`{
      "d1_databases": [
        { "binding": "BOOKKIT_DB", "database_name": "bookings" },
        // more databases can be added here
      ],
      /* block comment */
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

  it('forwards --env with its value without treating it as a database name', () => {
    const result = run('{ "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "bookings" }] }', ['--env', 'production']);

    expect(result.status).toBe(0);
    expect(result.capturedArgs()).toContain('bookings');
    expect(result.capturedArgs()).toContainEqual('--env');
    expect(result.capturedArgs()).toContainEqual('production');
  });

  it('forwards --persist-to and value options written with =', () => {
    const persistResult = run('{ "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "bookings" }] }', ['--persist-to', '.wrangler/state']);
    const equalsResult = run('{ "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "bookings" }] }', ['--env=production']);

    expect(persistResult.status).toBe(0);
    expect(persistResult.capturedArgs()).toContainEqual('--persist-to');
    expect(persistResult.capturedArgs()).toContainEqual('.wrangler/state');
    expect(equalsResult.status).toBe(0);
    expect(equalsResult.capturedArgs()).toContainEqual('--env=production');
  });

  it('keeps value options and the database name separate in either order', () => {
    const before = run('{ "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "configured" }] }', ['chosen', '--env', 'production']);
    const after = run('{ "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "configured" }] }', ['--env', 'production', 'chosen']);

    expect(before.status).toBe(0);
    expect(before.capturedArgs()).toContain('chosen');
    expect(before.capturedArgs()).toContain('production');
    expect(after.status).toBe(0);
    expect(after.capturedArgs()).toContain('chosen');
    expect(after.capturedArgs()).toContain('production');
  });

  it('rejects unknown options with the supported option list', () => {
    const result = run('{ "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "bookings" }] }', ['--unknown']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unsupported option `--unknown`.*Supported options:.*--env/s);
  });

  it('passes arguments after -- to wrangler verbatim, without forwarding the -- separator itself', () => {
    // The first separator is consumed by Bun before it invokes the script under test.
    const result = run('{ "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "bookings" }] }', ['--', '--', '--future-option', 'future-value']);

    expect(result.status).toBe(0);
    expect(result.capturedArgs()).toEqual(expect.arrayContaining(['--future-option', 'future-value']));
    // A literal -- reaching wrangler would make it stop parsing options, turning the
    // passthrough flags into positional arguments instead.
    expect(result.capturedArgs()).not.toContain('--');
  });

  it('accepts an equals-form value that begins with a dash without misreading it as another flag', () => {
    const result = run('{ "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "bookings" }] }', ['--persist-to=-x']);

    expect(result.status).toBe(0);
    expect(result.capturedArgs()).toContainEqual('--persist-to=-x');
  });

  it('rejects more than one database name', () => {
    const result = run('{ "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "bookings" }] }', ['first', 'second']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unexpected database name `second`/);
  });
});
