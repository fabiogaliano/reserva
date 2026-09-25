import type { ResolvedClientConfig } from '../core/config.js';
import { escapeHtml } from '../http.js';
import type { ThemePreference } from './theme.js';

export type PageBranding = NonNullable<NonNullable<ResolvedClientConfig['ui']>['branding']>;

// Scoped by the body hook classes rather than :root so the operator pages, which load the same
// stylesheet, keep Reserva's own look.
const customerPages = ['.bk-page--confirmation', '.bk-page--manage'];

function channel(hex: string): number {
  const value = Number.parseInt(hex, 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: string): number {
  const hex = color.slice(1);
  const full = hex.length === 3 ? hex.split('').map((digit) => digit + digit).join('') : hex;
  return 0.2126 * channel(full.slice(0, 2)) + 0.7152 * channel(full.slice(2, 4)) + 0.0722 * channel(full.slice(4, 6));
}

// Whichever of white or near-black text reads better on the accent, by WCAG contrast ratio: the
// consumer names one brand color and button labels stay legible on it.
export function accentContrastColor(accent: string): string {
  const luminance = relativeLuminance(accent);
  const dark = relativeLuminance('#14151a');
  return (1.05 / (luminance + 0.05)) >= ((luminance + 0.05) / (dark + 0.05)) ? '#ffffff' : '#14151a';
}

// Appended to the served stylesheet (never inlined), so branded pages still need only
// style-src 'self'. Empty for a deployment without branding, keeping its stylesheet unchanged.
export function brandingCss(branding: PageBranding | undefined): string {
  if (!branding) return '';
  const tokens: string[] = [];
  if (branding.accentColor) {
    const accent = branding.accentColor;
    tokens.push(
      `--bk-accent: ${accent};`,
      `--bk-accent-contrast: ${accentContrastColor(accent)};`,
      `--bk-accent-soft: color-mix(in srgb, ${accent} 12%, var(--bk-surface));`,
      // --bk-focus is computed where it is declared (:root), from :root's accent, so it has to be
      // restated next to the accent it should follow.
      `--bk-focus: 0 0 0 3px color-mix(in srgb, ${accent} 50%, transparent);`,
    );
  }
  if (branding.fontFamily) tokens.push(`--bk-font: ${branding.fontFamily};`);
  const rules: string[] = [];
  if (tokens.length > 0) rules.push(`${customerPages.join(', ')} {\n  ${tokens.join('\n  ')}\n}`);
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
