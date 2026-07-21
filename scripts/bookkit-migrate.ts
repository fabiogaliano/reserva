#!/usr/bin/env bun
// Thin wrapper around `wrangler d1 migrations apply`, published as the `bookkit-migrate` bin so
// consumers can run `bunx bookkit-migrate --local` instead of hand-writing a db:migrate script.
// Node builtins only (no runtime dependency): it shells out to whatever `wrangler` is on PATH
// (the consumer's own devDependency) rather than bundling or vendoring wrangler itself.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Strips // and /* */ comments plus trailing commas so wrangler.jsonc can be read with
// JSON.parse — not a full JSONC parser, just enough to pull one field out of it.
function stripJsonc(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
}

function readDatabaseName(configPath: string): string | undefined {
  if (!configPath.endsWith('.json') && !configPath.endsWith('.jsonc')) return undefined;
  try {
    const parsed = JSON.parse(stripJsonc(readFileSync(configPath, 'utf8'))) as {
      d1_databases?: Array<{ database_name?: string }>;
    };
    return parsed.d1_databases?.[0]?.database_name;
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
      configPath = argv[index += 1];
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

  const databaseName = explicitDatabaseName ?? readDatabaseName(configPath);
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
