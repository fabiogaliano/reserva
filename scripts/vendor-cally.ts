// Regenerates src/ui/vendor/cally-bundle.ts from the installed cally package. The served
// /booking/assets/reserva.js route can't use a Vite `?raw` import: in a consumer's dev server the
// Cloudflare module runner denies file ids outside the consumer project root (reserva lives in
// node_modules, or behind a symlink), so the bundle is vendored as a plain string module instead.
// Run after bumping the cally dependency: bun scripts/vendor-cally.ts

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'node_modules/cally/dist/cally.js'), 'utf8');
const { version } = JSON.parse(readFileSync(resolve(root, 'node_modules/cally/package.json'), 'utf8')) as { version: string };

const target = resolve(root, 'src/ui/vendor/cally-bundle.ts');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(
  target,
  `// Generated from cally@${version} by scripts/vendor-cally.ts — do not edit by hand.\n`
  + `export const callyVersion = ${JSON.stringify(version)};\n`
  + `export const callyBundleJs: string = ${JSON.stringify(source)};\n`,
);
console.log(`Vendored cally@${version} → src/ui/vendor/cally-bundle.ts (${source.length} bytes)`);
