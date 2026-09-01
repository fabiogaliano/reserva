#!/usr/bin/env bun
// Regenerates the contract tables inside README.md and AGENTS.md from the exported constants that
// define them, so documentation of a closed vocabulary cannot drift from the vocabulary itself.
// `--check` re-renders without writing and fails when the committed docs differ;
// CI runs that, `bun run docs:contract` fixes it.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_ERROR_CODES } from '../src/core/api.js';
import { BOOKING_EVENTS } from '../src/core/events.js';
import { routeManifest } from '../src/routes-manifest.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['README.md', 'AGENTS.md'];

function inlineList(values: readonly string[]): string {
  return values.map((value) => `\`${value}\``).join(', ');
}

const SECTIONS: Record<string, string> = {
  routes: [
    '| Route id | Path | Group |',
    '|---|---|---|',
    ...routeManifest.map((route) => `| \`${route.id}\` | \`${route.pattern}\` | ${route.group} |`),
  ].join('\n'),
  'error-codes': inlineList(API_ERROR_CODES),
  'booking-events': inlineList(BOOKING_EVENTS),
};

// The markers are HTML comments so they render as nothing; everything between a pair is owned by
// this script and overwritten wholesale.
function render(source: string, file: string): string {
  let output = source;
  for (const [name, body] of Object.entries(SECTIONS)) {
    const start = `<!-- generated:${name} -->`;
    const end = `<!-- /generated:${name} -->`;
    const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
    if (!pattern.test(output)) {
      console.error(`contract-docs: ${file} is missing the ${start} … ${end} markers`);
      process.exit(1);
    }
    output = output.replace(pattern, `${start}\n${body}\n${end}`);
  }
  return output;
}

const check = process.argv.includes('--check');
let drifted = false;

for (const file of TARGETS) {
  const path = resolve(repoRoot, file);
  const source = readFileSync(path, 'utf8');
  const rendered = render(source, file);
  if (source === rendered) continue;
  if (check) {
    drifted = true;
    console.error(`contract-docs: ${file} is out of date with the exported constants`);
  } else {
    writeFileSync(path, rendered);
    console.log(`contract-docs: updated ${file}`);
  }
}

if (drifted) {
  console.error('contract-docs: run `bun run docs:contract` and commit the result');
  process.exit(1);
}
console.log(check ? 'contract-docs: up to date' : 'contract-docs: OK');
