import { escapeHtml } from '../http';
import type { BookkitMessages } from './messages';
import type { ThemePreference } from './theme';

export interface PageShellOptions {
  lang: string;
  title: string;
  cssHref: string;
  body: string;
  // Page identity (brand, title, badges, lead) rendered inside the dark masthead band; the main
  // content then overlaps its lower edge. Raw HTML, caller escapes. Customer-facing pages.
  header?: string;
  // App-shell navigation (the dark sidebar) for operator surfaces; mutually exclusive with
  // header in practice — sidebar wins if both are set. Raw HTML, caller escapes.
  sidebar?: string;
  // Content column width for masthead pages: default 44rem, mid 56rem, wide 72rem.
  width?: 'mid' | 'wide';
  // Extra raw head markup (e.g. the confirmation page's meta refresh). Caller escapes.
  headExtra?: string;
  // External first-party module (the assetsJs route) — never inline script, for CSP.
  scriptHref?: string;
  // The viewer's forced theme, reflected onto <html data-theme> so first paint matches their
  // choice without an inline script. Absent/undefined = follow the OS (prefers-color-scheme).
  theme?: ThemePreference | undefined;
  // Pre-built theme-toggle control (see themeToggle below); placed in the masthead or sidebar.
  themeToggle?: string;
}

// Shared document chrome for every server-rendered bookkit page. Styling comes exclusively from
// the linked stylesheet (the assetsCss route) — no inline styles or scripts — so these pages work
// unchanged under a strict style-src/script-src 'self' CSP.
export function pageShell(options: PageShellOptions): string {
  const stylesheet = options.cssHref ? `<link rel="stylesheet" href="${escapeHtml(options.cssHref)}">` : '';
  const head = `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${options.headExtra ?? ''}<title>${escapeHtml(options.title)}</title>${stylesheet}${options.scriptHref ? `<script type="module" src="${escapeHtml(options.scriptHref)}"></script>` : ''}</head>`;
  const htmlTag = `<html lang="${escapeHtml(options.lang)}"${options.theme ? ` data-theme="${options.theme}"` : ''}>`;
  const toggle = options.themeToggle ?? '';
  if (options.sidebar) {
    const content = `<div class="bk-shell"><nav class="bk-sidebar">${options.sidebar}${toggle}</nav><div class="bk-shell-main"><main class="bk-main bk-main--shell">${options.body}</main></div></div>`;
    return `<!doctype html>${htmlTag}${head}<body class="bk-page">${content}</body></html>`;
  }
  const widthClass = options.width === 'wide' ? ' bk-main--wide' : options.width === 'mid' ? ' bk-main--mid' : '';
  const innerWidthClass = options.width === 'wide' ? ' bk-masthead-inner--wide' : options.width === 'mid' ? ' bk-masthead-inner--mid' : '';
  const masthead = options.header
    ? `<header class="bk-masthead"><div class="bk-masthead-inner${innerWidthClass}">${toggle}${options.header}</div></header>`
    : '';
  const mainClass = `bk-main${widthClass}${options.header ? ' bk-main--raised' : ''}`;
  return `<!doctype html>${htmlTag}${head}<body class="bk-page">${masthead}<main class="${mainClass}">${options.body}</main></body></html>`;
}

// Builds the per-viewer theme toggle: a button the enhancer reveals and wires (see ui/theme-toggle).
// Rendered hidden with the current mode + labels as data-* so the enhancer needs no separate i18n
// island. `theme` is the viewer's forced choice; undefined renders as "System" (follow the OS).
export function themeToggle(messages: BookkitMessages, theme: ThemePreference | undefined): string {
  const mode = theme ?? 'system';
  return `<button type="button" class="bk-theme-toggle" data-bookkit-theme-toggle hidden`
    + ` data-mode="${mode}"`
    + ` data-aria="${escapeHtml(messages['theme.toggle'])}"`
    + ` data-l-system="${escapeHtml(messages['theme.system'])}"`
    + ` data-l-light="${escapeHtml(messages['theme.light'])}"`
    + ` data-l-dark="${escapeHtml(messages['theme.dark'])}"></button>`;
}

const statusTone: Record<string, string> = {
  confirmed: 'ok',
  hold: 'warn',
  cancelled: 'danger',
  expired: 'danger',
  no_show: 'warn',
};

export function statusToneOf(status: string): string | undefined {
  return statusTone[status];
}

export function statusBadge(status: string, messages: BookkitMessages): string {
  const key = `status.${status}` as keyof BookkitMessages;
  const label = (messages[key] as string | undefined) ?? status;
  const tone = statusTone[status];
  return `<span class="bk-badge${tone ? ` bk-badge--${tone}` : ''}">${escapeHtml(label)}</span>`;
}

export function factList(rows: Array<[label: string, valueHtml: string]>): string {
  const items = rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`).join('');
  return `<dl class="bk-facts">${items}</dl>`;
}
