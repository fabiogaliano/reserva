import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import packageJson from '../package.json';

// Guards the tree-shake story documented in README's "Providers" section: `@reservajs/astro/providers`
// is a convenience barrel (it pulls every provider's module into the graph), so the real
// narrow-import contract is the per-provider subpaths in the exports map. Two structural checks
// stand in for "narrow subpaths are actually narrow": `sideEffects: false` licenses bundlers to
// drop unused exports at all, and no provider entrypoint may either run code on import or reach
// sideways into another provider's directory — the two ways importing one provider could still
// drag another provider's SDK-facing code into a consumer's bundle.

// The exports map names the emitted file; tsc mirrors src/ into dist/, so each target is read back
// through that mapping.
const providerSubpaths = Object.entries(packageJson.exports as Record<string, { types: string; default: string } | string>)
  .filter(([specifier]) => specifier.startsWith('./providers/'))
  .map(([specifier, target]) => [
    specifier,
    (typeof target === 'string' ? target : target.default).replace(/^\.\/dist\//, './src/').replace(/\.js$/, '.ts'),
  ] as [string, string]);

function sourceOf(relativeTarget: string): string {
  return readFileSync(resolve(import.meta.dirname, '..', relativeTarget), 'utf8');
}

// Comments are prose: a brace, a semicolon or a keyword inside one must not reach either scan
// below. Blanked rather than deleted so the source's line structure survives.
function blankComments(source: string): string {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const pair = source.slice(index, index + 2);
    if (pair !== '//' && pair !== '/*') {
      output += source[index];
      index += 1;
      continue;
    }
    const lineEnd = source.indexOf('\n', index);
    const end = pair === '//' ? (lineEnd === -1 ? source.length : lineEnd) : source.indexOf('*/', index + 2) + 2;
    output += source.slice(index, end).replace(/[^\n]/g, ' ');
    index = end;
  }
  return output;
}

// String and template contents are the other place a brace can appear without being one. Only the
// statement scan needs this; the import scan below reads the specifiers these hold.
function blankStrings(code: string): string {
  let output = '';
  let index = 0;
  while (index < code.length) {
    const char = code[index]!;
    if (char !== '"' && char !== "'" && char !== '`') {
      output += char;
      index += 1;
      continue;
    }
    let cursor = index + 1;
    while (cursor < code.length && code[cursor] !== char) cursor += code[cursor] === '\\' ? 2 : 1;
    output += char + code.slice(index + 1, cursor).replace(/[^\n]/g, ' ') + char;
    index = cursor + 1;
  }
  return output;
}

// A `{` that closes a declaration body ends the statement; every other kind (an import/export
// clause, an object or type literal) leaves the statement running until its `;`.
const BODY_OWNER = /\b(?:function|class|interface|enum|namespace)\b/;

// Splits a module into its top-level statements. Good enough for a structural guardrail because it
// only has to tell "declaration" from "statement that runs" — it never has to understand what the
// declaration says.
function topLevelStatements(source: string): string[] {
  const code = blankStrings(blankComments(source));
  const statements: string[] = [];
  let depth = 0;
  let start = 0;
  let closesStatement = false;
  for (let index = 0; index < code.length; index += 1) {
    const char = code[index]!;
    if (char === '{' || char === '(' || char === '[') {
      if (depth === 0) closesStatement = char === '{' && BODY_OWNER.test(code.slice(start, index));
      depth += 1;
    } else if (char === '}' || char === ')' || char === ']') depth -= 1;
    if (depth !== 0 || !(char === ';' || (char === '}' && closesStatement))) continue;
    statements.push(code.slice(start, index + 1).trim());
    start = index + 1;
  }
  const trailing = code.slice(start).trim();
  if (trailing) statements.push(trailing);
  return statements.filter(Boolean);
}

const DECLARATION_START = /^(?:export\b|import\b|declare\b|abstract\b|async\s+function\b|function\b|class\b|const\b|let\b|var\b|interface\b|type\b|enum\b|namespace\b)/;

// Every relative specifier a module imports or re-exports from.
function relativeSpecifiers(source: string): string[] {
  return [...blankComments(source).matchAll(/from\s+'([^']+)'|import\s+'([^']+)'/g)]
    .map((match) => match[1] ?? match[2] ?? '')
    .filter((specifier) => specifier.startsWith('.'));
}

describe('provider subpath tree-shake guardrail', () => {
  it('declares only CSS as side-effectful so bundlers may drop unused provider exports', () => {
    // The array form must never grow a JS/TS pattern: listing any script file would revoke the
    // bundler's licence to drop unused provider code. CSS is the one legitimate side effect
    // (src/ui/components.css is imported bare by the shipped Astro components).
    expect(packageJson.sideEffects).toEqual(['**/*.css']);
  });

  it('has at least one narrow provider subpath to guard', () => {
    expect(providerSubpaths.length).toBeGreaterThan(0);
  });

  it.each(providerSubpaths)('%s runs no code at import time', (_specifier, relativeTarget) => {
    const statements = topLevelStatements(sourceOf(relativeTarget));
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) expect(statement).toMatch(DECLARATION_START);
  });

  it.each(providerSubpaths)('%s does not reach into another provider', (specifier, relativeTarget) => {
    const providersRoot = resolve(import.meta.dirname, '..', 'src', 'providers');
    const ownDirectory = resolve(providersRoot, specifier.replace('./providers/', ''));
    const entrypointDirectory = dirname(resolve(import.meta.dirname, '..', relativeTarget));
    for (const imported of relativeSpecifiers(sourceOf(relativeTarget))) {
      const target = resolve(entrypointDirectory, imported);
      if (!target.startsWith(`${providersRoot}/`)) continue;
      expect(target.startsWith(`${ownDirectory}/`)).toBe(true);
    }
  });
});
