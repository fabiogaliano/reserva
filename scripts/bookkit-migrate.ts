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
      let next = index + 1;
      while (/\s/.test(source[next] ?? '')) next += 1;
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

function fail(message: string): never {
  console.error(`bookkit-migrate: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { configPath: string | undefined; databaseName: string | undefined; passthrough: string[] } {
  let configPath: string | undefined;
  let databaseName: string | undefined;
  const passthrough: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      const path = argv[index + 1];
      if (!path || path.startsWith('--')) fail('`--config` requires a path argument');
      configPath = path;
      index += 1;
    } else if (arg?.startsWith('--')) {
      passthrough.push(arg);
    } else if (arg && !databaseName) {
      databaseName = arg;
    }
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
