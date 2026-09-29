import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GET as getCss } from '../src/routes/booking/assets';
import { GET as getJs } from '../src/routes/booking/assets-js';
import { cssAssetHref, jsAssetHref } from '../src/ui/asset-hrefs';
import { brandingCss, contrastRatio, darkAccentPalette, lightAccentPalette } from '../src/ui/branding';
import { darkTokenValues, lightTokenValues } from '../src/ui/generated/tokens';
import { themeCss } from '../src/ui/theme';

const repoRoot = resolve(import.meta.dirname, '..');
const componentsCss = readFileSync(resolve(repoRoot, 'src/ui/components.css'), 'utf8');
const embedTokensCss = readFileSync(resolve(repoRoot, 'src/ui/generated/embed-tokens.css'), 'utf8');
const light = (name: string) => lightTokenValues[name] as string;
const dark = (name: string) => darkTokenValues[name] ?? light(name);
// The masthead's gradient stops (theme.ts), the same in both schemes.
const mastheadStops = ['#111216', '#0a0b0d'];

// Only the token prelude: rules further down legitimately use :root in @media print.
const tokenPrelude = themeCss.slice(0, themeCss.indexOf('.bk-page {'));

// Flat enough stylesheets that a selector is whatever sits between a block boundary and `{`.
function selectorsOf(css: string): string[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...code.matchAll(/(?:^|[{};])\s*([^{};@]+?)\s*\{/g)].map((match) => match[1] as string);
}

describe('token specificity (a plain :root override wins in both schemes)', () => {
  it('declares every page default inside :where()', () => {
    const selectors = selectorsOf(tokenPrelude);
    expect(selectors.length).toBeGreaterThanOrEqual(4);
    for (const selector of selectors) expect(selector).toMatch(/^:where\(.*\)$/);
  });

  // Both sit at zero specificity, so only source order lets a forced dark choice beat the OS rule.
  it('puts the forced theme after the OS media rule', () => {
    expect(tokenPrelude.indexOf(':where(:root[data-theme="dark"])')).toBeGreaterThan(tokenPrelude.indexOf(':where(:root:not([data-theme]))'));
  });

  it('keeps the dark palette off paper', () => {
    expect(tokenPrelude).not.toMatch(/@media \(prefers-color-scheme: dark\)/);
    expect(tokenPrelude.match(/@media screen/g)).toHaveLength(2);
    expect(themeCss).toMatch(/@media print \{\n\s+:root \{ color-scheme: light; \}/);
  });
});

describe('embed tokens (components.css never touches the host :root)', () => {
  // Freshness against tokens.css is `bun run generate:check`'s job; this pins that it is loaded at all.
  it('is imported by components.css', () => {
    expect(componentsCss).toContain("@import './generated/embed-tokens.css';");
  });

  it('scopes tokens and color-scheme to .bk-embed only, at zero specificity', () => {
    expect(embedTokensCss).not.toContain(':root');
    expect(componentsCss).not.toContain(':root');
    const selectors = selectorsOf(embedTokensCss);
    expect(selectors.length).toBeGreaterThanOrEqual(5);
    for (const selector of selectors) {
      expect(selector).toMatch(/^:where\(.*\.bk-embed.*\)$/);
    }
  });

  it('follows a host data-theme before the OS preference', () => {
    const osDark = embedTokensCss.indexOf(':where(.bk-embed:not([data-theme="light"] *))');
    const forcedDark = embedTokensCss.indexOf(':where([data-theme="dark"] .bk-embed)');
    const forcedLight = embedTokensCss.indexOf(':where([data-theme="light"] .bk-embed) { color-scheme: light; }');
    expect(osDark).toBeGreaterThan(-1);
    expect(forcedDark).toBeGreaterThan(osDark);
    expect(forcedLight).toBeGreaterThan(-1);
  });
});

describe('focus ring', () => {
  it('never removes the outline, so forced-colors mode still shows focus', () => {
    expect(themeCss).not.toContain('outline: none');
    expect(componentsCss).not.toContain('outline: none');
  });

  // Declared on :root, a ring token would freeze :root's accent; read at the rule, it follows a
  // scoped `.bk-page--manage { --bk-accent: … }`.
  it('reads var(--bk-accent) where it is drawn instead of a :root-computed token', () => {
    expect(themeCss).not.toContain('--bk-focus');
    expect(componentsCss).not.toContain('--bk-focus');
    expect(themeCss.match(/:focus-visible[^{]*\{[^}]*outline: 2px solid var\(--bk-accent\)/g)?.length).toBeGreaterThanOrEqual(15);
    expect(componentsCss.match(/outline: 2px solid var\(--bk-accent\)/g)).toHaveLength(2);
    expect(themeCss).toContain(':is(.bk-masthead, .bk-topbar) :is(a, button):focus-visible { outline-color: var(--bk-masthead-text); }');
  });

  it('clears 3:1 against every surface it is drawn on', () => {
    for (const surface of ['--bk-surface', '--bk-bg', '--bk-surface-2']) {
      expect(contrastRatio(light('--bk-accent'), light(surface))).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(dark('--bk-accent'), dark(surface))).toBeGreaterThanOrEqual(3);
    }
    for (const stop of mastheadStops) expect(contrastRatio(light('--bk-masthead-text'), stop)).toBeGreaterThanOrEqual(3);
  });
});

describe('default token contrast', () => {
  it('keeps accent text at 4.5:1 on the soft background and the second surface in both schemes', () => {
    expect(themeCss).toContain('.bk-badge--accent { background: var(--bk-accent-soft); color: var(--bk-accent-text); }');
    for (const surface of ['--bk-accent-soft', '--bk-surface-2']) {
      expect(contrastRatio(light('--bk-accent-text'), light(surface))).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(dark('--bk-accent-text'), dark(surface))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps masthead list text at 4.5:1 on the masthead', () => {
    expect(themeCss).toContain('.bk-masthead .bk-lead + .bk-list { margin: 0.5rem 0 0; color: var(--bk-masthead-muted); }');
    for (const stop of mastheadStops) expect(contrastRatio(light('--bk-masthead-muted'), stop)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('branding accent palettes', () => {
  const accents = ['#0f6b3f', '#5e6ad2', '#b3261e', '#1a1a1a', '#f5c518', '#00f', '#ff7a00', '#7c3aed'];

  it.each(accents)('derives a dark variant of %s that reads on the dark surface, with a legible label', (accent) => {
    const palette = darkAccentPalette(accent);
    expect(contrastRatio(palette.accent, dark('--bk-surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.accent, palette.contrast)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.text, palette.soft)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.text, dark('--bk-surface-2'))).toBeGreaterThanOrEqual(4.5);
  });

  // The accent text is drawn on the soft tint (the accent badge) and on the second surface (the
  // confirmation ticket's month); a bright accent like #f5c518 clears the first and not the second.
  it.each(accents)('keeps the light accent-text of %s at 4.5:1 on its soft background and the second surface', (accent) => {
    const palette = lightAccentPalette(accent);
    expect(palette.accent).toBe(accent);
    expect(contrastRatio(palette.text, palette.soft)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.text, light('--bk-surface-2'))).toBeGreaterThanOrEqual(4.5);
  });

  it('lightens only as far as needed, and leaves an accent that already reads untouched', () => {
    expect(darkAccentPalette('#0f6b3f')).toEqual({ accent: '#448c69', contrast: '#14151a', soft: '#1c2824', text: '#59997a' });
    expect(darkAccentPalette('#f5c518').accent).toBe('#f5c518');
  });

  it('emits the dark variant under both dark conditions unless the pages are pinned light', () => {
    const auto = brandingCss({ accentColor: '#0f6b3f' });
    expect(auto).toContain('@media screen and (prefers-color-scheme: dark) {\n  :where(:root:not([data-theme])) .bk-page--confirmation, :where(:root:not([data-theme])) .bk-page--manage {\n    --bk-accent: #448c69;');
    expect(auto).toContain('@media screen {\n  :where(:root[data-theme="dark"]) .bk-page--confirmation, :where(:root[data-theme="dark"]) .bk-page--manage {\n    --bk-accent: #448c69;');
    // After the light rule, at the same specificity, so it wins only when its condition holds.
    expect(auto.indexOf('--bk-accent: #448c69;')).toBeGreaterThan(auto.indexOf('--bk-accent: #0f6b3f;'));
    expect(brandingCss({ accentColor: '#0f6b3f', colorScheme: 'dark' })).toContain('#448c69');
    expect(brandingCss({ accentColor: '#0f6b3f', colorScheme: 'light' })).not.toContain('#448c69');
    expect(brandingCss({ accentColor: '#0f6b3f', colorScheme: 'light' })).not.toContain('prefers-color-scheme');
  });
});

describe('asset cache headers', () => {
  const at = (href: string) => ({ url: new URL(href, 'https://example.test') });
  const immutable = 'public, max-age=31536000, immutable';

  it('caches the stylesheet for a year only under the version the pages link to', () => {
    const href = cssAssetHref('/booking/assets/reserva.css');
    expect(getCss(at(href)).headers.get('cache-control')).toBe(immutable);
    expect(getCss(at('/booking/assets/reserva.css')).headers.get('cache-control')).toBe('no-store');
    expect(getCss(at('/booking/assets/reserva.css?v=stale')).headers.get('cache-control')).toBe('no-store');
    // The branding suffix is part of the version, so an unbranded href must not match a branded one.
    expect(getCss(at(`${href}-x`)).headers.get('cache-control')).toBe('no-store');
  });

  it('caches the script bundle for a year only under its current version', () => {
    expect(getJs(at(jsAssetHref('/booking/assets/reserva.js'))).headers.get('cache-control')).toBe(immutable);
    expect(getJs(at('/booking/assets/reserva.js')).headers.get('cache-control')).toBe('no-store');
    expect(getJs(at('/booking/assets/reserva.js?v=stale')).headers.get('cache-control')).toBe('no-store');
  });
});
