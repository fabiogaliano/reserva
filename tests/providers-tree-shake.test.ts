import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import packageJson from '../package.json';

// Guards the tree-shake story documented in README's "Providers" section: `bookkit/providers` is a
// convenience barrel (it pulls every provider SDK import, e.g. `stripe`, into the graph), so the
// real narrow-import contract is the per-provider subpaths below. Two structural checks stand in
// for "narrow subpaths are actually narrow": `sideEffects: false` licenses bundlers to drop unused
// exports at all, and each subpath must resolve to a shim that *only* re-exports — never a file
// that could itself run top-level side-effecting code regardless of what a bundler decides.
const reExportLine = /^export\s+(?:\*|\{[^}]*\})\s+from\s+'\.{1,2}\/[^']+';$/;

const providerSubpaths = Object.entries(packageJson.exports as Record<string, string>)
  .filter(([specifier]) => specifier.startsWith('./providers/'));

describe('providers barrel tree-shake guardrail', () => {
  it('declares sideEffects: false so bundlers may drop unused provider exports', () => {
    expect(packageJson.sideEffects).toBe(false);
  });

  it('has at least one narrow provider subpath to guard', () => {
    expect(providerSubpaths.length).toBeGreaterThan(0);
  });

  it.each(providerSubpaths)('%s resolves to a re-export-only shim', (_specifier, relativeTarget) => {
    const filePath = resolve(import.meta.dirname, '..', relativeTarget);
    const lines = readFileSync(filePath, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(reExportLine);
  });
});
