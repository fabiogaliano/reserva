import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOKKIT_MIGRATIONS } from '../src/migrations-manifest';

const scriptPath = resolve(process.cwd(), 'scripts/bookkit-migrate.ts');
// Both computed the same way the CLI itself does: resolvePackagedMigrationsDir() resolves
// `../migrations` from scripts/bookkit-migrate.ts, i.e. this repo's root migrations/ directory.
const packagedMigrationsDir = resolve(process.cwd(), 'migrations');
const wranglerBinDir = resolve(process.cwd(), 'node_modules/.bin');
const fixtureDirectories: string[] = [];

function fixtureDirectory(options: { failWrangler?: boolean } = {}): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'bookkit-migrate-'));
  fixtureDirectories.push(directory);
  const wranglerPath = resolve(directory, 'wrangler');
  writeFileSync(wranglerPath, [
    '#!/bin/sh',
    'printf "%s\\n" "$@" >> "$BOOKKIT_MIGRATE_ARGS"',
    // Snapshot the config bookkit-migrate actually invoked wrangler with, so tests can inspect a
    // derived config's content -- bookkit-migrate deletes it in its own `finally` right after this
    // stub exits, so without this the file would already be gone by the time the test looks.
    'prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "--config" ]; then cp "$arg" "$BOOKKIT_MIGRATE_CONFIG_SNAPSHOT"; fi',
    '  prev="$arg"',
    'done',
    options.failWrangler ? 'exit 7' : 'exit 0',
    '',
  ].join('\n'));
  chmodSync(wranglerPath, 0o755);
  return directory;
}

function run(
  config: string,
  args: string[] = [],
  setup?: (cwd: string) => void,
  options: { configFilename?: string; failWrangler?: boolean } = {},
) {
  const cwd = fixtureDirectory(options.failWrangler === undefined ? {} : { failWrangler: options.failWrangler });
  const capturedArgsPath = resolve(cwd, 'wrangler-args.txt');
  const capturedConfigPath = resolve(cwd, 'wrangler-config-snapshot.txt');
  writeFileSync(resolve(cwd, options.configFilename ?? 'wrangler.jsonc'), config);
  setup?.(cwd);
  const result = spawnSync('bun', [scriptPath, ...args], {
    cwd,
    env: {
      ...process.env,
      PATH: `${cwd}:${process.env.PATH ?? ''}`,
      BOOKKIT_MIGRATE_ARGS: capturedArgsPath,
      BOOKKIT_MIGRATE_CONFIG_SNAPSHOT: capturedConfigPath,
    },
    encoding: 'utf8',
  });
  return {
    ...result,
    cwd,
    capturedArgs: () => readFileSync(capturedArgsPath, 'utf8').trim().split('\n'),
    // `--config`'s value is whatever bookkit-migrate decided to pass wrangler -- the consumer's own
    // config unchanged, or a derived sibling copy with only the selected entry's migrations_dir set.
    capturedConfigArg: () => {
      const parts = readFileSync(capturedArgsPath, 'utf8').trim().split('\n');
      const index = parts.indexOf('--config');
      return index === -1 ? undefined : parts[index + 1];
    },
    capturedConfigSnapshot: () => readFileSync(capturedConfigPath, 'utf8'),
    wranglerInvoked: () => existsSync(capturedArgsPath),
    derivedFiles: () => readdirSync(cwd).filter((name) => name.startsWith('.bookkit-migrate.')),
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

  it('uses an explicit database name (matched by binding) in preference to configuration selection', () => {
    const result = run(`{
      "d1_databases": [
        { "binding": "ANALYTICS_DB", "database_name": "analytics" },
        { "binding": "OTHER_DB", "database_name": "other" }
      ]
    }`, ['ANALYTICS_DB', '--local']);

    expect(result.status).toBe(0);
    expect(result.capturedArgs()).toContain('analytics');
    expect(result.capturedArgs()).not.toContain('other');
  });

  it('rejects an explicit database name that matches no configured D1 entry', () => {
    const result = run(`{
      "d1_databases": [
        { "binding": "ANALYTICS_DB", "database_name": "analytics" },
        { "binding": "OTHER_DB", "database_name": "other" }
      ]
    }`, ['unconfigured', '--local']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/`unconfigured` does not match any configured D1 entry.*analytics.*other/s);
    expect(result.wranglerInvoked()).toBe(false);
  });

  it('rejects an explicit database name that matches more than one configured D1 entry', () => {
    // "shared" is both the first entry's database_name and the second entry's binding.
    const result = run(`{
      "d1_databases": [
        { "binding": "FIRST_DB", "database_name": "shared" },
        { "binding": "shared", "database_name": "second" }
      ]
    }`, ['shared', '--local']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/`shared` matches multiple configured D1 entries.*shared.*second/s);
    expect(result.wranglerInvoked()).toBe(false);
  });

  it('selects the named environment D1 binding instead of the top-level binding', () => {
    const result = run(`{
      "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "development-bookings" }],
      "env": {
        "production": {
          "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "production-bookings" }]
        }
      }
    }`, ['--env', 'production']);

    expect(result.status).toBe(0);
    expect(result.capturedArgs()).toContain('production-bookings');
    expect(result.capturedArgs()).not.toContain('development-bookings');
    expect(result.capturedArgs()).toContainEqual('--env');
    expect(result.capturedArgs()).toContainEqual('production');
  });

  it('requires an explicit database name when the named environment has no D1 bindings', () => {
    const result = run('{ "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "development-bookings" }] }', ['--env', 'production']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/environment `production`.*no d1_databases binding.*pass the database name explicitly/s);
  });

  it('discovers the default config beneath --cwd instead of the process directory', () => {
    const result = run('{ "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "root-bookings" }] }', ['--cwd', 'app'], (cwd) => {
      const app = resolve(cwd, 'app');
      mkdirSync(app);
      writeFileSync(resolve(app, 'wrangler.jsonc'), '{ "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "app-bookings" }] }');
    });

    expect(result.status).toBe(0);
    expect(result.capturedArgs()).toContain('app-bookings');
    expect(result.capturedArgs()).not.toContain('root-bookings');
    expect(result.capturedArgs()).toContainEqual('--cwd');
    expect(result.capturedArgs()).toContainEqual('app');
  });

  it('forwards --persist-to and value options written with =', () => {
    const persistResult = run('{ "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "bookings" }] }', ['--persist-to', '.wrangler/state']);
    const equalsResult = run('{ "env": { "production": { "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "bookings" }] } } }', ['--env=production']);

    expect(persistResult.status).toBe(0);
    expect(persistResult.capturedArgs()).toContainEqual('--persist-to');
    expect(persistResult.capturedArgs()).toContainEqual('.wrangler/state');
    expect(equalsResult.status).toBe(0);
    expect(equalsResult.capturedArgs()).toContainEqual('--env=production');
  });

  it('keeps value options and the database name separate in either order', () => {
    const config = '{ "env": { "production": { "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "configured" }] } } }';
    const before = run(config, ['configured', '--env', 'production']);
    const after = run(config, ['--env', 'production', 'configured']);

    expect(before.status).toBe(0);
    expect(before.capturedArgs()).toContain('configured');
    expect(before.capturedArgs()).toContain('production');
    expect(after.status).toBe(0);
    expect(after.capturedArgs()).toContain('configured');
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

// Plan 008: the CLI must tell Wrangler where bookkit's packaged migrations live -- previously it
// only forwarded the consumer's own `--config`, so a consumer with no `migrations_dir` got nothing
// applied (or, worse, applied a colliding directory of the consumer's own). Since Wrangler has no
// `--migrations-dir` flag, the mechanism writes a derived config with only the selected entry's
// `migrations_dir` overridden. These tests use the arg-capturing stub above (fast) to inspect the
// derived config's *content*, since bookkit-migrate deletes the file itself right after wrangler
// exits -- a real invocation would only prove wrangler accepted it, not what was actually written.
describe('bookkit-migrate derived config (plan 008)', () => {
  it('overrides only the selected entry\'s migrations_dir and leaves the rest of the config untouched', () => {
    const result = run(`{
      "name": "consumer-site",
      "compatibility_date": "2026-07-21",
      "vars": { "SOME_VAR": "kept" },
      "d1_databases": [
        { "binding": "ANALYTICS_DB", "database_name": "analytics" },
        { "binding": "BOOKKIT_DB", "database_name": "bookings" }
      ]
    }`, ['--local']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`bookkit-migrate: applying bookkit's packaged migrations from ${packagedMigrationsDir}`);
    // The derived config lives beside the original, not in the original's place.
    expect(result.capturedConfigArg()).not.toBe(resolve(result.cwd, 'wrangler.jsonc'));

    const derived = JSON.parse(result.capturedConfigSnapshot());
    expect(derived.name).toBe('consumer-site');
    expect(derived.vars).toEqual({ SOME_VAR: 'kept' });
    expect(derived.d1_databases[0]).toEqual({ binding: 'ANALYTICS_DB', database_name: 'analytics' });
    expect(derived.d1_databases[1]).toEqual({ binding: 'BOOKKIT_DB', database_name: 'bookings', migrations_dir: packagedMigrationsDir });
  });

  it('overrides only the selected --env entry\'s migrations_dir in a TOML config, preserving a custom migrations_table', () => {
    const result = run(`
name = "consumer-site"
compatibility_date = "2026-07-21"

[[d1_databases]]
binding = "BOOKKIT_DB"
database_name = "development-bookings"

[[env.production.d1_databases]]
binding = "BOOKKIT_DB"
database_name = "production-bookings"
migrations_table = "custom_migrations"
`, ['--env', 'production', '--local'], undefined, { configFilename: 'wrangler.toml' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`bookkit-migrate: applying bookkit's packaged migrations from ${packagedMigrationsDir}`);

    const derived = parseToml(result.capturedConfigSnapshot()) as {
      d1_databases: Array<{ binding: string; database_name: string; migrations_dir?: string }>;
      env: { production: { d1_databases: Array<{ binding: string; database_name: string; migrations_table?: string; migrations_dir?: string }> } };
    };
    // The top-level (non-selected) entry is untouched.
    expect(derived.d1_databases[0]).toEqual({ binding: 'BOOKKIT_DB', database_name: 'development-bookings' });
    // The selected environment entry keeps its migrations_table and gains migrations_dir.
    expect(derived.env.production.d1_databases[0]).toEqual({
      binding: 'BOOKKIT_DB', database_name: 'production-bookings',
      migrations_table: 'custom_migrations', migrations_dir: packagedMigrationsDir,
    });
  });

  it('uses the consumer config unchanged when migrations_dir already resolves to the packaged directory', () => {
    const result = run(`{
      "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "bookings", "migrations_dir": ${JSON.stringify(packagedMigrationsDir)} }]
    }`, ['--local']);

    expect(result.status).toBe(0);
    // realpathSync: on macOS, os.tmpdir() is under a /tmp symlink, so the child process's own
    // process.cwd() (which the CLI uses to find the default config) reports the real, non-symlinked
    // path -- resolve() alone doesn't follow symlinks, so a literal string comparison needs it too.
    expect(result.capturedConfigArg()).toBe(resolve(realpathSync(result.cwd), 'wrangler.jsonc'));
    expect(result.derivedFiles()).toEqual([]);
  });

  it('fails with a hard error naming both paths when migrations_dir points elsewhere', () => {
    const result = run(`{
      "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "bookings", "migrations_dir": "./my-own-migrations" }]
    }`, ['--local']);

    expect(result.status).toBe(1);
    expect(result.wranglerInvoked()).toBe(false);
    expect(result.stderr).toMatch(/does not point at bookkit's packaged migrations/);
    expect(result.stderr).toContain('my-own-migrations');
    expect(result.stderr).toContain(packagedMigrationsDir);
  });
});

// Plan 008 step 4: the derived config is a temp file, not part of the consumer's repo -- it must
// never survive the invocation, whether wrangler succeeds or fails, and concurrent invocations
// (e.g. two CI jobs) must never race on the same filename.
describe('bookkit-migrate derived config cleanup (plan 008)', () => {
  const noMigrationsDirConfig = '{ "d1_databases": [{ "binding": "BOOKKIT_DB", "database_name": "bookings" }] }';

  it('removes the derived config after wrangler succeeds', () => {
    const result = run(noMigrationsDirConfig, ['--local']);

    expect(result.status).toBe(0);
    expect(result.derivedFiles()).toEqual([]);
  });

  it('removes the derived config after wrangler fails', () => {
    const result = run(noMigrationsDirConfig, ['--local'], undefined, { failWrangler: true });

    expect(result.status).toBe(7);
    expect(result.derivedFiles()).toEqual([]);
  });

  it('gives two concurrent-style invocations distinct derived config filenames', () => {
    const first = run(noMigrationsDirConfig, ['--local'], undefined, { failWrangler: true });
    const second = run(noMigrationsDirConfig, ['--local'], undefined, { failWrangler: true });

    // Each invocation's own fixture directory is separate, so this compares the derived filename
    // -- not just the directory -- by checking neither run's snapshot ever collided mid-flight.
    expect(first.capturedConfigArg()).not.toBe(second.capturedConfigArg());
    expect(first.capturedConfigArg()?.split('/').pop()).not.toBe(second.capturedConfigArg()?.split('/').pop());
  });
});

// Plan 008: the CLI must tell Wrangler where bookkit's packaged migrations live -- previously it
// only forwarded the consumer's own `--config`, so a consumer with no `migrations_dir` got nothing
// applied. This proves the fix against REAL wrangler (not the arg-capturing stub above): Wrangler
// has no `--migrations-dir` flag, so this is the mechanism's load-bearing assumption -- Wrangler
// must accept an absolute `migrations_dir` in a derived config file.
describe('bookkit-migrate applies bookkit packaged migrations against real wrangler (plan 008)', () => {
  function realFixtureDirectory(): string {
    const directory = mkdtempSync(resolve(tmpdir(), 'bookkit-migrate-real-'));
    fixtureDirectories.push(directory);
    return directory;
  }

  function realRun(cwd: string, args: string[] = []) {
    return spawnSync('bun', [scriptPath, ...args], {
      cwd,
      env: { ...process.env, PATH: `${wranglerBinDir}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });
  }

  // wrangler's own `apply` output includes a pre-flight table (pending items marked 🕒) as well as
  // the results table, so scraping `apply`'s stdout can't distinguish "about to apply" from
  // "applied". A separate `migrations list` against a config that points migrations_dir at the
  // same packaged directory, over the same local persistence root (same directory => same default
  // `.wrangler/state/v3`), is the authoritative "nothing left pending" check used throughout.
  function assertNothingPending(cwd: string, databaseName: string, options: { extraArgs?: string[]; migrationsTable?: string } = {}) {
    const entry: Record<string, unknown> = {
      binding: 'BOOKKIT_DB', database_name: databaseName,
      database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: packagedMigrationsDir,
      ...(options.migrationsTable ? { migrations_table: options.migrationsTable } : {}),
    };
    const verifyConfigPath = resolve(cwd, `verify-${databaseName}.wrangler.jsonc`);
    writeFileSync(verifyConfigPath, JSON.stringify({
      name: 'fixture',
      compatibility_date: '2026-07-21',
      env: { production: { d1_databases: [entry] } },
      d1_databases: [entry],
    }));
    const listResult = spawnSync('wrangler', ['d1', 'migrations', 'list', databaseName, '--config', verifyConfigPath, '--local', ...(options.extraArgs ?? [])], {
      cwd,
      env: { ...process.env, PATH: `${wranglerBinDir}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    });
    expect(listResult.stdout).toContain('No migrations to apply');
  }

  it('applies every manifest migration from the packaged directory when the consumer config has no migrations_dir', () => {
    const cwd = realFixtureDirectory();
    writeFileSync(resolve(cwd, 'wrangler.jsonc'), `{
      "name": "fixture",
      "compatibility_date": "2026-07-21",
      "d1_databases": [
        { "binding": "BOOKKIT_DB", "database_name": "fixture-db", "database_id": "00000000-0000-0000-0000-000000000000" }
      ]
    }`);

    const result = realRun(cwd, ['--local']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`applying bookkit's packaged migrations from ${packagedMigrationsDir}`);
    for (const name of BOOKKIT_MIGRATIONS) expect(result.stdout).toContain(name);
    assertNothingPending(cwd, 'fixture-db');
  }, 20_000);

  it('applies a custom-migrations_table --env database from a TOML config, and reuses persisted state on a second run', () => {
    const cwd = realFixtureDirectory();
    writeFileSync(resolve(cwd, 'wrangler.toml'), `
name = "fixture"
compatibility_date = "2026-07-21"

[[env.production.d1_databases]]
binding = "BOOKKIT_DB"
database_name = "fixture-prod-db"
database_id = "00000000-0000-0000-0000-000000000000"
migrations_table = "custom_migrations"
`);

    const first = realRun(cwd, ['--env', 'production', '--local']);
    expect(first.status).toBe(0);
    for (const name of BOOKKIT_MIGRATIONS) expect(first.stdout).toContain(name);
    assertNothingPending(cwd, 'fixture-prod-db', { extraArgs: ['--env', 'production'], migrationsTable: 'custom_migrations' });

    // Persistence: the second run reuses the same consumer .wrangler/state/v3 (same cwd => same
    // project root => same default persist-to), so nothing should be left to apply this time.
    const second = realRun(cwd, ['--env', 'production', '--local']);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('No migrations to apply');
  }, 20_000);
});
