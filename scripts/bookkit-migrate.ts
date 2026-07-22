#!/usr/bin/env bun
// Thin wrapper around `wrangler d1 migrations apply`, published as the `bookkit-migrate` bin so
// consumers can run `bunx bookkit-migrate --local` instead of hand-writing a db:migrate script.
// Node builtins only (no runtime dependency): it shells out to whatever `wrangler` is on PATH
// (the consumer's own devDependency) rather than bundling or vendoring wrangler itself.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
}

type DatabaseSelection =
  | { kind: 'selected'; databaseName: string }
  | { kind: 'ambiguous'; candidates: string[] };

function readDatabaseSelection(configPath: string): DatabaseSelection | undefined {
  if (!configPath.endsWith('.json') && !configPath.endsWith('.jsonc')) return undefined;
  try {
    const parsed = JSON.parse(stripJsonc(readFileSync(configPath, 'utf8'))) as {
      d1_databases?: D1DatabaseConfig[];
    };
    const databases = parsed.d1_databases;
    if (!databases) return undefined;
    const bookkitDatabase = databases.find((database) => database.binding === 'BOOKKIT_DB');
    if (bookkitDatabase?.database_name) return { kind: 'selected', databaseName: bookkitDatabase.database_name };
    if (databases.length === 1 && databases[0]?.database_name) {
      return { kind: 'selected', databaseName: databases[0].database_name };
    }
    return { kind: 'ambiguous', candidates: databases.flatMap((database) => database.database_name ? [database.database_name] : []) };
  } catch {
    return undefined;
  }
}

function defaultConfigPath(): string | undefined {
  return ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']
    .map((name) => resolve(process.cwd(), name))
    .find((candidate) => existsSync(candidate));
}

const usage = `Usage: bookkit-migrate [database_name] [options]

Value options: -c, --config; --cwd; -e, --env; --env-file; --profile; --persist-to
Boolean options: --local; --remote; --preview; --install-skills; -h, --help; -v, --version
Use -- to pass all remaining arguments to wrangler verbatim.`;

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

function fail(message: string): never {
  console.error(`bookkit-migrate: ${message}\n${usage}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { configPath: string | undefined; databaseName: string | undefined; passthrough: string[] } {
  let configPath: string | undefined;
  let databaseName: string | undefined;
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
      } else if (inlineValue === undefined) {
        passthrough.push(name, value);
      } else {
        passthrough.push(arg);
      }
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (databaseName) fail(`unexpected database name \`${arg}\`; only one database name may be supplied`);
    databaseName = arg;
  }
  return { configPath, databaseName, passthrough };
}

function main(): void {
  const { configPath: explicitConfigPath, databaseName: explicitDatabaseName, passthrough } = parseArgs(process.argv.slice(2));

  const configPath = explicitConfigPath ?? defaultConfigPath();
  if (!configPath || !existsSync(configPath)) {
    fail('no wrangler config found (looked for wrangler.jsonc, wrangler.json, wrangler.toml in the current directory); pass --config <path>');
  }

  const selection = explicitDatabaseName ? undefined : readDatabaseSelection(configPath);
  if (selection?.kind === 'ambiguous') {
    fail(`multiple D1 databases found in ${configPath}: ${selection.candidates.join(', ')}. Pass one explicitly, e.g. \`bookkit-migrate <database_name> --local\``);
  }
  const databaseName = explicitDatabaseName ?? selection?.databaseName;
  if (!databaseName) {
    fail(`could not read a D1 database_name from ${configPath}; pass it explicitly, e.g. \`bookkit-migrate <database_name> --local\``);
  }

  const wranglerArgs = ['d1', 'migrations', 'apply', databaseName, '--config', configPath, ...passthrough];
  const result = spawnSync('wrangler', wranglerArgs, { stdio: 'inherit' });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      fail('`wrangler` was not found on PATH; add it as a devDependency and run this through your package manager (e.g. `bunx bookkit-migrate`)');
    }
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

main();
