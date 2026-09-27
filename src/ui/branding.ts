import type { ResolvedClientConfig } from '../core/config.js';
import { escapeHtml } from '../http.js';
import { darkTokenValues, lightTokenValues } from './generated/tokens.js';
import type { ThemePreference } from './theme.js';

export type PageBranding = NonNullable<NonNullable<ResolvedClientConfig['ui']>['branding']>;

// Scoped by the body hook classes rather than :root so the operator pages, which load the same
// stylesheet, keep Reserva's own look.
const customerPages = ['.bk-page--confirmation', '.bk-page--manage'];

type Rgb = [number, number, number];

function parseHex(color: string): Rgb {
  const hex = color.slice(1);
  const full = hex.length === 3 ? hex.split('').map((digit) => digit + digit).join('') : hex;
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16)) as Rgb;
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: string): number {
  const [red, green, blue] = parseHex(color);
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

export function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

function mix(from: string, to: string, amountOfTo: number): string {
  const start = parseHex(from);
  const end = parseHex(to);
  return `#${start.map((value, index) => Math.round(value + ((end[index] as number) - value) * amountOfTo).toString(16).padStart(2, '0')).join('')}`;
}

// The first 1% step from `color` toward `target` that satisfies `accept`, checked on the rounded
// hex that is actually emitted, so the ratio holds exactly rather than approximately — which
// color-mix() in the browser could not promise. The first hit stays closest to the brand color.
function nudge(color: string, target: string, accept: (candidate: string) => boolean): string {
  for (let step = 0; step <= 100; step += 1) {
    const candidate = mix(color, target, step / 100);
    if (accept(candidate)) return candidate;
  }
  return target;
}

// Whichever of white or near-black text reads better on the accent, by WCAG contrast ratio: the
// consumer names one brand color and button labels stay legible on it.
export function accentContrastColor(accent: string): string {
  return contrastRatio(accent, '#ffffff') >= contrastRatio(accent, '#14151a') ? '#ffffff' : '#14151a';
}

export interface AccentPalette {
  accent: string;
  contrast: string;
  soft: string;
  text: string;
}

// Mixed against the default surfaces from tokens.css: that is what the soft tint sits on unless the
// consumer restyles the page, and it is what the text ratio is guaranteed against.
const lightSurface = lightTokenValues['--bk-surface'] as string;
const darkSurface = darkTokenValues['--bk-surface'] as string;
// Accent text also sits on the second surface (the confirmation ticket's month), which is darker
// than the tint in light mode, so the text has to clear both.
const lightSurface2 = lightTokenValues['--bk-surface-2'] as string;
const darkSurface2 = darkTokenValues['--bk-surface-2'] as string;

export function lightAccentPalette(accent: string): AccentPalette {
  const soft = mix(lightSurface, accent, 0.12);
  return {
    accent,
    contrast: accentContrastColor(accent),
    soft,
    text: nudge(accent, '#000000', (candidate) => contrastRatio(candidate, soft) >= 4.5 && contrastRatio(candidate, lightSurface2) >= 4.5),
  };
}

// One brand color rarely works on both surfaces: a green picked for white pages sinks into the
// dark one. The dark variant is the brand color lightened just enough to clear 4.5:1 on the dark
// surface while its own label color still clears 4.5:1 on it.
export function darkAccentPalette(accent: string): AccentPalette {
  const lifted = nudge(accent, '#ffffff', (candidate) => contrastRatio(candidate, darkSurface) >= 4.5
    && contrastRatio(candidate, accentContrastColor(candidate)) >= 4.5);
  const soft = mix(darkSurface, lifted, 0.16);
  return {
    accent: lifted,
    contrast: accentContrastColor(lifted),
    soft,
    text: nudge(lifted, '#ffffff', (candidate) => contrastRatio(candidate, soft) >= 4.5 && contrastRatio(candidate, darkSurface2) >= 4.5),
  };
}

function accentTokens(palette: AccentPalette): string[] {
  return [
    `--bk-accent: ${palette.accent};`,
    `--bk-accent-contrast: ${palette.contrast};`,
    `--bk-accent-soft: ${palette.soft};`,
    `--bk-accent-text: ${palette.text};`,
  ];
}

function ruleFor(selectors: string[], tokens: string[], indent = ''): string {
  return `${indent}${selectors.join(', ')} {\n${tokens.map((token) => `${indent}  ${token}`).join('\n')}\n${indent}}`;
}

// Appended to the served stylesheet (never inlined), so branded pages still need only
// style-src 'self'. Empty for a deployment without branding, keeping its stylesheet unchanged.
export function brandingCss(branding: PageBranding | undefined): string {
  if (!branding) return '';
  const tokens: string[] = [];
  if (branding.accentColor) tokens.push(...accentTokens(lightAccentPalette(branding.accentColor)));
  if (branding.fontFamily) tokens.push(`--bk-font: ${branding.fontFamily};`);
  const rules: string[] = [];
  if (tokens.length > 0) rules.push(ruleFor(customerPages, tokens));
  // The same two dark conditions as the default palette in theme.ts, prefixed inside :where() so
  // these keep the light rule's specificity and a consumer's later `.bk-page--manage { … }` still
  // wins in both schemes. A page pinned light never matches either, so it gets no dark rules.
  if (branding.accentColor && branding.colorScheme !== 'light') {
    const dark = accentTokens(darkAccentPalette(branding.accentColor));
    const scoped = (root: string) => customerPages.map((page) => `:where(${root}) ${page}`);
    rules.push(
      `@media screen and (prefers-color-scheme: dark) {\n${ruleFor(scoped(':root:not([data-theme])'), dark, '  ')}\n}`,
      `@media screen {\n${ruleFor(scoped(':root[data-theme="dark"]'), dark, '  ')}\n}`,
    );
  }
  if (branding.mastheadBackground) {
    rules.push(`${customerPages.map((page) => `${page} .bk-masthead`).join(', ')} { background: ${branding.mastheadBackground}; }`);
  }
  return rules.length > 0 ? `\n/* ui.branding */\n${rules.join('\n')}\n` : '';
}

// A pinned scheme overrides the viewer's cookie on the customer pages; `undefined` for the
// forced value means the page follows the viewer as before.
export function customerPageTheme(branding: PageBranding | undefined, viewerTheme: ThemePreference | undefined): { theme: ThemePreference | undefined; pinned: boolean } {
  const scheme = branding?.colorScheme;
  if (scheme === 'light' || scheme === 'dark') return { theme: scheme, pinned: true };
  return { theme: viewerTheme, pinned: false };
}

// The masthead's brand line: the logo when one is configured, otherwise the business name as text.
export function brandMark(name: string, url: string | undefined, branding: PageBranding | undefined): string {
  const mark = branding?.logoUrl
    ? `<img class="bk-brand-logo" src="${escapeHtml(branding.logoUrl)}" alt="${escapeHtml(name)}"`
      + `${branding.logoWidth ? ` width="${branding.logoWidth}"` : ''}${branding.logoHeight ? ` height="${branding.logoHeight}"` : ''}>`
    : escapeHtml(name);
  return `<p class="bk-brand">${url ? `<a href="${escapeHtml(url)}">${mark}</a>` : mark}</p>`;
}
