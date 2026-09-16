#!/usr/bin/env bun
// Regenerates the contract tables in README.md and AGENTS.md from the exported constants that
// define them, so documentation of a closed vocabulary cannot drift from the vocabulary itself.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_ERROR_CODES } from '../src/core/api.js';
import { BOOKING_EVENTS } from '../src/core/events.js';
import { routeManifest } from '../src/routes-manifest.js';
import { readTokensCss, tokenDeclarations } from './generate-ui-tokens';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Per file, because the token table only belongs in the customization guide while the contract
// tables belong in both entry-point docs.
const TARGETS: Record<string, string[]> = {
  'README.md': ['routes', 'error-codes', 'booking-events'],
  'AGENTS.md': ['routes', 'error-codes', 'booking-events'],
  'docs/customization.md': ['ui-tokens'],
};

function inlineList(values: readonly string[]): string {
  return values.map((value) => `\`${value}\``).join(', ');
}

// Light is the declared set; a token absent from the dark block keeps its light value, which the
// table says explicitly rather than leaving the cell blank.
function tokenTable(): string {
  const css = readTokensCss(repoRoot);
  const dark = new Map(tokenDeclarations(css, 'dark').map((token) => [token.name, token.value]));
  return [
    '| Token | Light default | Dark default |',
    '|---|---|---|',
    ...tokenDeclarations(css, 'light').map((token) => (
      `| \`${token.name}\` | \`${token.value}\` | ${dark.has(token.name) ? `\`${dark.get(token.name)}\`` : 'same as light'} |`
    )),
  ].join('\n');
}

const SECTIONS: Record<string, string> = {
  routes: [
    '| Route id | Path | Group |',
    '|---|---|---|',
    ...routeManifest.map((route) => `| \`${route.id}\` | \`${route.pattern}\` | ${route.group} |`),
  ].join('\n'),
  'error-codes': inlineList(API_ERROR_CODES),
  'booking-events': inlineList(BOOKING_EVENTS),
  'ui-tokens': tokenTable(),
};

// The markers are HTML comments so they render as nothing; everything between a pair is owned by
// this script and overwritten wholesale.
function render(source: string, file: string, names: string[]): string {
  let output = source;
  for (const name of names) {
    const body = SECTIONS[name] as string;
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

for (const [file, names] of Object.entries(TARGETS)) {
  const path = resolve(repoRoot, file);
  const source = readFileSync(path, 'utf8');
  const rendered = render(source, file, names);
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
