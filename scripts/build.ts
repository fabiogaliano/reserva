#!/usr/bin/env bun
// Produces the complete publish artifact in dist/: compiled JS + declarations + source maps from
// tsc, plus the raw files tsc has no notion of. The `.astro` components are copied, never
// precompiled — Astro compiles them inside the consumer's own build — and they are copied to the
// path that mirrors their position under src/, so their relative imports (`../routes-manifest`,
// `../ui/components.css`) land on the corresponding emitted files without any path rewriting.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The non-TypeScript files no TypeScript source *imports*, as `src/` path -> `dist/` path. A JSON
// file reached by a real import (src/ui/locales/*.json, via messages.ts) is already resolved and
// emitted into dist/ by tsc under resolveJsonModule — adding a new locale needs nothing here; only
// a file tsc never sees in the module graph (an `.astro` component the consumer compiles, a
// stylesheet linked by URL) belongs in this list.
const RAW_ASSETS = [
  'components/ManageBooking.astro',
  'components/AdminDashboard.astro',
  'ui/components.css',
];

function fail(message: string): never {
  console.error(`build: ${message}`);
  process.exit(1);
}

rmSync(resolve(repoRoot, 'dist'), { recursive: true, force: true });

const tsc = spawnSync('bunx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: repoRoot, stdio: 'inherit' });
if (tsc.status !== 0) fail('`tsc -p tsconfig.build.json` failed');

for (const relativePath of RAW_ASSETS) {
  const source = resolve(repoRoot, 'src', relativePath);
  const target = resolve(repoRoot, 'dist', relativePath);
  if (!existsSync(source)) fail(`missing raw asset ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

console.log(`build: dist/ ready (tsc output + ${RAW_ASSETS.length} raw assets)`);
