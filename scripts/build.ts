#!/usr/bin/env bun
// `.astro` components are copied, never precompiled — Astro compiles them inside the consumer's
// own build — into the path that mirrors their position under src/, so their relative imports land
// on the corresponding emitted files without any path rewriting.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Only files no TypeScript source *imports* belong here: anything tsc resolves through the module
// graph (e.g. JSON via resolveJsonModule) is already emitted into dist/ on its own.
const RAW_ASSETS = [
  'components/ManageBooking.astro',
  'ui/components.css',
];

function fail(message: string): never {
  console.error(`build: ${message}`);
  process.exit(1);
}

rmSync(resolve(repoRoot, 'dist'), { recursive: true, force: true });

const tsc = spawnSync('bunx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: repoRoot, stdio: 'inherit' });
if (tsc.status !== 0) fail('`tsc -p tsconfig.build.json` failed');

// npm rejects TypeScript bin targets. Bundle the CLI separately so consumers receive an executable
// while its import.meta.url still resolves ../migrations at the package root.
const cli = spawnSync(
  'bun',
  ['build', 'scripts/reserva-migrate.ts', '--target=node', '--outfile=dist/reserva-migrate.js'],
  { cwd: repoRoot, stdio: 'inherit' },
);
if (cli.status !== 0) fail('reserva-migrate build failed');

for (const relativePath of RAW_ASSETS) {
  const source = resolve(repoRoot, 'src', relativePath);
  const target = resolve(repoRoot, 'dist', relativePath);
  if (!existsSync(source)) fail(`missing raw asset ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

console.log(`build: dist/ ready (tsc output + reserva-migrate + ${RAW_ASSETS.length} raw assets)`);
