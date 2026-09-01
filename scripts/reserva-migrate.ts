#!/usr/bin/env bun
// Thin wrapper around `wrangler d1 migrations apply`, published as the `reserva-migrate` bin so
// consumers can run `bunx reserva-migrate --local` instead of hand-writing a db:migrate script.
// Node builtins only for JSON/JSONC configs (no runtime dependency for the common case): it shells
// out to whatever `wrangler` is on PATH (the consumer's own devDependency) rather than bundling or
// vendoring wrangler itself. `smol-toml` is loaded dynamically, only for TOML configs.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Strips comments and trailing commas outside JSON strings so wrangler.jsonc can be read with
// JSON.parse — not a full JSONC parser, just enough to pull the D1 configuration out of it.
function stripJsonc(source: string): string {
  let output = '';
  let index = 0;
  let inString = false;
  let escaped = false;

  while (index < source.length) {
    const character = source[index] ?? '';
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n' || source[index] === '\r') output += source[index];
        index += 1;
      }
      if (index < source.length) index += 2;
      continue;
    }
    if (character === ',') {
      // The lookahead must skip comments as well as whitespace: comments are removed from the
      // output on later iterations, so a comma judged trailing only against whitespace would
      // survive as `,\n]` once a comment between it and the bracket is stripped.
      let next = index + 1;
      for (;;) {
        if (/\s/.test(source[next] ?? '')) {
          next += 1;
        } else if (source[next] === '/' && source[next + 1] === '/') {
          next += 2;
          while (next < source.length && source[next] !== '\n' && source[next] !== '\r') next += 1;
        } else if (source[next] === '/' && source[next + 1] === '*') {
          next += 2;
          while (next < source.length && !(source[next] === '*' && source[next + 1] === '/')) next += 1;
          if (next < source.length) next += 2;
        } else {
          break;
        }
      }
      if (source[next] === '}' || source[next] === ']') {
        index += 1;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return output;
}

interface D1DatabaseConfig {
  binding?: string;
  database_name?: string;
  migrations_dir?: string;
  [key: string]: unknown;
}

// The subset of wrangler.jsonc/.toml this tool reads/writes; everything else is opaque and
// preserved verbatim through clone + targeted mutation, never re-derived field by field — future
// Wrangler config keys (account metadata, other bindings, etc.) survive untouched.
interface WranglerConfigRoot {
  d1_databases?: D1DatabaseConfig[];
  env?: Record<string, { d1_databases?: D1DatabaseConfig[] }>;
  [key: string]: unknown;
}

class CliFailure extends Error {}

const usage = `Usage: reserva-migrate [database_name] [options]

Value options: -c, --config; --cwd; -e, --env; --env-file; --profile; --persist-to
Boolean options: --local; --remote; --preview; --install-skills; -h, --help; -v, --version
Use -- to pass all remaining arguments to wrangler verbatim.`;

function fail(message: string): never {
  throw new CliFailure(`reserva-migrate: ${message}\n${usage}`);
}

// Resolved from the script's own location, not the consumer's cwd: at `bin.reserva-migrate`,
// `../migrations` relative to this file is reserva's packaged migrations/ directory both in this
// repo (scripts/ -> repo root) and in an installed package (`files` ships both scripts/ and
// migrations/ at the package root — see package.json).
function resolvePackagedMigrationsDir(): string {
  return fileURLToPath(new URL('../migrations', import.meta.url));
}

type ConfigFormat = 'json' | 'toml';

function configFormat(configPath: string): ConfigFormat {
  return configPath.endsWith('.toml') ? 'toml' : 'json';
}

async function parseConfig(configPath: string, source: string): Promise<WranglerConfigRoot> {
  try {
    if (configFormat(configPath) === 'toml') {
      // Dynamic import: reserva's first runtime dependency, loaded only for TOML consumers so
      // JSON/JSONC consumers (the common case) never pull it into their module graph.
      const { parse } = await import('smol-toml');
      return parse(source) as WranglerConfigRoot;
    }
    return JSON.parse(stripJsonc(source)) as WranglerConfigRoot;
  } catch (error) {
    fail(`could not parse ${configPath} as ${configFormat(configPath) === 'toml' ? 'TOML' : 'JSON/JSONC'}: ${(error as Error).message}`);
  }
}

async function writeDerivedConfig(configPath: string, root: WranglerConfigRoot): Promise<void> {
  if (configFormat(configPath) === 'toml') {
    const { stringify } = await import('smol-toml');
    writeFileSync(configPath, stringify(root));
  } else {
    // Valid JSON is valid JSONC; this file is machine-written and machine-read by wrangler only,
    // so comment preservation from the source config is neither needed nor attempted.
    writeFileSync(configPath, JSON.stringify(root, null, 2));
  }
}

// Written beside the consumer's own config (not in os.tmpdir()) so wrangler's project root, and
// therefore its default `.wrangler/state/v3` local-persistence location, is unaffected — see the
// "derived-config location" design decision. randomUUID() makes concurrent invocations collision-
// resistant without a retry loop.
function uniqueSiblingConfigPath(configPath: string): string {
  return resolve(dirname(configPath), `.reserva-migrate.${randomUUID()}${extname(configPath)}`);
}

type DatabaseSelection =
  | { kind: 'selected'; entry: D1DatabaseConfig }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'name-not-found'; name: string; candidates: string[] }
  | { kind: 'name-ambiguous'; name: string; candidates: string[] }
  | { kind: 'environment-missing-databases'; environment: string }
  | { kind: 'no-databases' };

function databasesForEnvironment(root: WranglerConfigRoot, environment: string | undefined): D1DatabaseConfig[] | undefined {
  // Wrangler environment bindings are non-inheritable, so a named environment must never select a
  // top-level database merely because its own section omitted d1_databases.
  return environment === undefined ? root.d1_databases : root.env?.[environment]?.d1_databases;
}

// Selection is explicit and uniform, whether or not a positional database name was passed: a
// derived config must never guess database metadata, so an explicit name that doesn't identify
// exactly one configured entry fails here rather than being passed to wrangler blind.
function selectDatabaseEntry(root: WranglerConfigRoot, environment: string | undefined, explicitName: string | undefined): DatabaseSelection {
  const databases = databasesForEnvironment(root, environment);
  if (!databases || (environment !== undefined && databases.length === 0)) {
    return environment === undefined ? { kind: 'no-databases' } : { kind: 'environment-missing-databases', environment };
  }
  const candidateNames = databases.flatMap((database) => (database.database_name ? [database.database_name] : []));
  if (explicitName !== undefined) {
    const matches = databases.filter((database) => database.binding === explicitName || database.database_name === explicitName);
    if (matches.length === 1) return { kind: 'selected', entry: matches[0]! };
    if (matches.length === 0) return { kind: 'name-not-found', name: explicitName, candidates: candidateNames };
    return { kind: 'name-ambiguous', name: explicitName, candidates: candidateNames };
  }
  const reservaDatabase = databases.find((database) => database.binding === 'RESERVA_DB');
  if (reservaDatabase?.database_name) return { kind: 'selected', entry: reservaDatabase };
  if (databases.length === 1 && databases[0]?.database_name) return { kind: 'selected', entry: databases[0] };
  return { kind: 'ambiguous', candidates: candidateNames };
}

function defaultConfigPath(cwd: string): string | undefined {
  return ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']
    .map((name) => resolve(cwd, name))
    .find((candidate) => existsSync(candidate));
}

type OptionArity = 'value' | 'boolean';

// Keep this list aligned with `wrangler d1 migrations apply --help` so values never become a
// database positional argument before the command reaches Wrangler.
const optionArity: Readonly<Record<string, OptionArity>> = {
  '-c': 'value',
  '--config': 'value',
  '--cwd': 'value',
  '-e': 'value',
  '--env': 'value',
  '--env-file': 'value',
  '--profile': 'value',
  '--persist-to': 'value',
  '--local': 'boolean',
  '--remote': 'boolean',
  '--preview': 'boolean',
  '--install-skills': 'boolean',
  '-h': 'boolean',
  '--help': 'boolean',
  '-v': 'boolean',
  '--version': 'boolean',
};

function parseArgs(argv: string[]): {
  configPath: string | undefined;
  cwd: string | undefined;
  databaseName: string | undefined;
  environment: string | undefined;
  passthrough: string[];
} {
  let configPath: string | undefined;
  let cwd: string | undefined;
  let databaseName: string | undefined;
  let environment: string | undefined;
  const passthrough: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === '--') {
      // Consume the separator itself: wrangler treats a literal `--` as "stop parsing options",
      // which would turn everything meant to pass through as flags into positional arguments.
      passthrough.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith('-')) {
      const equalsIndex = arg.indexOf('=');
      const name = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
      const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
      const arity = optionArity[name];
      if (!arity) fail(`unsupported option \`${name}\`. Supported options: ${Object.keys(optionArity).join(', ')}`);
      if (arity === 'boolean') {
        if (inlineValue !== undefined) fail(`boolean option \`${name}\` does not take a value`);
        passthrough.push(arg);
        continue;
      }
      const value = inlineValue ?? argv[index + 1];
      // `--flag=value` is unambiguous, so a value that itself looks like a flag (e.g. a path
      // starting with `-`) must be accepted; only the space-separated form is ambiguous with a
      // following `--flag` and needs the lookahead guard.
      if (inlineValue === undefined) {
        if (!value || value.startsWith('-')) {
          fail(name === '-c' || name === '--config' ? `\`${name}\` requires a path argument` : `\`${name}\` requires a value`);
        }
      } else if (!value) {
        fail(name === '-c' || name === '--config' ? `\`${name}\` requires a path argument` : `\`${name}\` requires a value`);
      }
      if (name === '-c' || name === '--config') {
        configPath = value;
      } else {
        if (name === '--cwd') cwd = value;
        if (name === '-e' || name === '--env') environment = value;
        if (inlineValue === undefined) {
          passthrough.push(name, value);
        } else {
          passthrough.push(arg);
        }
      }
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (databaseName) fail(`unexpected database name \`${arg}\`; only one database name may be supplied`);
    databaseName = arg;
  }
  return { configPath, cwd, databaseName, environment, passthrough };
}

async function run(): Promise<number> {
  let derivedConfigPath: string | undefined;
  try {
    const {
      configPath: explicitConfigPath,
      cwd: explicitCwd,
      databaseName: explicitDatabaseName,
      environment,
      passthrough,
    } = parseArgs(process.argv.slice(2));
    const configCwd = explicitCwd === undefined ? process.cwd() : resolve(process.cwd(), explicitCwd);
    const configPath = explicitConfigPath === undefined
      ? defaultConfigPath(configCwd)
      : resolve(configCwd, explicitConfigPath);
    if (!configPath || !existsSync(configPath)) {
      fail(`no wrangler config found (looked for wrangler.jsonc, wrangler.json, wrangler.toml in ${configCwd}); pass --config <path>`);
    }

    const source = readFileSync(configPath, 'utf8');
    const root = await parseConfig(configPath, source);
    const selection = selectDatabaseEntry(root, environment, explicitDatabaseName);

    if (selection.kind === 'environment-missing-databases') {
      fail(`environment \`${selection.environment}\` in ${configPath} has no d1_databases binding; pass the database name explicitly`);
    }
    if (selection.kind === 'no-databases') {
      fail(`could not read a D1 database_name from ${configPath}; pass it explicitly, e.g. \`reserva-migrate <database_name> --local\``);
    }
    if (selection.kind === 'ambiguous') {
      fail(`multiple D1 databases found in ${configPath}: ${selection.candidates.join(', ')}. Pass one explicitly, e.g. \`reserva-migrate <database_name> --local\``);
    }
    if (selection.kind === 'name-not-found') {
      fail(`\`${selection.name}\` does not match any configured D1 entry's binding or database_name in ${configPath}. Configured: ${selection.candidates.join(', ') || '(none)'}`);
    }
    if (selection.kind === 'name-ambiguous') {
      fail(`\`${selection.name}\` matches multiple configured D1 entries in ${configPath}: ${selection.candidates.join(', ')}`);
    }

    const { entry } = selection;
    const databaseName = entry.database_name;
    if (!databaseName) {
      fail(`the selected D1 entry in ${configPath} has no database_name; pass one explicitly, e.g. \`reserva-migrate <database_name> --local\``);
    }

    const packagedMigrationsDir = resolve(resolvePackagedMigrationsDir());
    let effectiveConfigPath = configPath;
    let effectiveMigrationsDir = packagedMigrationsDir;

    if (entry.migrations_dir !== undefined) {
      const configuredDir = resolve(dirname(configPath), entry.migrations_dir);
      if (configuredDir === packagedMigrationsDir) {
        // Already correctly configured (today's smoke-site behavior): use the consumer's config
        // unchanged rather than writing a redundant derived copy.
        effectiveMigrationsDir = configuredDir;
      } else {
        fail(
          `the selected D1 database's migrations_dir (\`${entry.migrations_dir}\`, resolved to ${configuredDir}) does not `
          + `point at reserva's packaged migrations (${packagedMigrationsDir}). Silently overriding a migrations_dir that `
          + `points elsewhere would risk applying the wrong migrations under reserva's name — it may be your own migration `
          + `pipeline. Point ${configPath}'s selected d1_databases entry's migrations_dir at ${packagedMigrationsDir}, or `
          + 'remove the field so reserva-migrate can derive it automatically.',
        );
      }
    } else {
      // Clone + re-select on the clone (rather than tracking array indices) to get a mutable
      // reference to the same entry inside a config we're free to rewrite; selection is a pure
      // function of (root, environment, explicitDatabaseName), so it lands on the same entry.
      const derivedRoot = structuredClone(root);
      const derivedSelection = selectDatabaseEntry(derivedRoot, environment, explicitDatabaseName);
      if (derivedSelection.kind !== 'selected') throw new Error('unreachable: selection changed between the original config and its clone');
      derivedSelection.entry.migrations_dir = packagedMigrationsDir;
      derivedConfigPath = uniqueSiblingConfigPath(configPath);
      await writeDerivedConfig(derivedConfigPath, derivedRoot);
      effectiveConfigPath = derivedConfigPath;
    }

    console.log(`reserva-migrate: applying reserva's packaged migrations from ${effectiveMigrationsDir}`);

    const wranglerArgs = ['d1', 'migrations', 'apply', databaseName, '--config', effectiveConfigPath, ...passthrough];
    const result = spawnSync('wrangler', wranglerArgs, { stdio: 'inherit' });
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
        fail('`wrangler` was not found on PATH; add it as a devDependency and run this through your package manager (e.g. `bunx reserva-migrate`)');
      }
      throw result.error;
    }
    return result.status ?? 1;
  } finally {
    // Cleanup must complete before the process status is set (below), whether wrangler succeeded,
    // failed, or a CliFailure was thrown above.
    if (derivedConfigPath) rmSync(derivedConfigPath, { force: true });
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await run();
  } catch (error) {
    if (error instanceof CliFailure) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

void main();
