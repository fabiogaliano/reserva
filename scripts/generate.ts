#!/usr/bin/env bun
// The two generated source modules are committed, not built on install: a git checkout must
// typecheck and run its tests without a build step. This keeps them honest the same way
// contract-docs keeps the README tables honest — `--check` fails when an input changed without
// the output being regenerated and committed.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchemaFingerprint, generateSchemaFingerprint, renderSchemaFingerprintModule } from './generate-schema-fingerprint';
import { generateUiTokens, readTokensCss, renderUiTokensModule } from './generate-ui-tokens';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const expected: Array<{ file: string; render: () => string; write: () => string }> = [
  {
    file: 'src/generated/schema-fingerprint.ts',
    render: () => renderSchemaFingerprintModule(buildSchemaFingerprint(resolve(repoRoot, 'migrations'))),
    write: () => generateSchemaFingerprint(repoRoot),
  },
  {
    file: 'src/ui/generated/tokens.ts',
    render: () => renderUiTokensModule(readTokensCss(repoRoot)),
    write: () => generateUiTokens(repoRoot),
  },
];

let drifted = false;
for (const { file, render, write } of expected) {
  const path = resolve(repoRoot, file);
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === render()) continue;
  if (check) {
    drifted = true;
    console.error(`generate: ${file} is out of date with its inputs`);
  } else {
    console.log(`generate: ${write()}`);
  }
}

if (drifted) {
  console.error('generate: run `bun run generate` and commit the result');
  process.exit(1);
}
console.log(check ? 'generate: up to date' : 'generate: OK');
