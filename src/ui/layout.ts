import type { ResolvedClientConfig } from '../core/config.js';
import { escapeHtml } from '../http.js';
import type { ReservaMessages } from './messages.js';
import type { ThemePreference } from './theme.js';

// Only the business contact is needed, so pages that hold a partial config (the manage renderer)
// can pass what they have without carrying a whole resolved config around.
export type ContactConfig = { business: Pick<ResolvedClientConfig['business'], 'contact'> };

// `tel:` and wa.me both reject the spaces, dashes and parentheses a human types into the admin
// settings form. wa.me wants a bare country code; `tel:` keeps a written '+' so an international
// number still dials correctly.
export function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

export function telHref(phone: string): string {
  return `${phone.trimStart().startsWith('+') ? '+' : ''}${digitsOf(phone)}`;
}

// wa.me has no country context to guess from, so only a number written in E.164 (a leading '+'
// and 8–15 digits, per the standard) can be linked — a local-format number would open a chat with
// whoever holds that number in the wrong country.
export function whatsappDigits(phone: string): string | null {
  if (!phone.trimStart().startsWith('+')) return null;
  const digits = digitsOf(phone);
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export function emailLink(email: string): string {
  return `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`;
}

// One customer phone rendered as every way to reach it: dialling on a phone, WhatsApp on a
// desktop. Used wherever a stored `customerPhone` is shown, so no surface is a dead string.
export function phoneLinks(phone: string, messages: ReservaMessages): string {
  const parts = [`<a href="tel:${escapeHtml(telHref(phone))}">${escapeHtml(phone)}</a>`];
  const whatsapp = whatsappDigits(phone);
  if (whatsapp) {
    parts.push(`<a href="https://wa.me/${escapeHtml(whatsapp)}" rel="noopener" target="_blank">${escapeHtml(messages['common.whatsapp'])}</a>`);
  }
  return parts.join(' · ');
}

// The one "how to reach a human" block: every dead end a customer can land on (a payment that
// never confirmed, a refused payment, a booking past its change deadline, a broken link) ends with
// the same contact details rather than each page inventing its own.
export function contactBlock(config: ContactConfig, messages: ReservaMessages): string {
  const contact = config.business.contact;
  const rows: string[] = [];
  if (contact.email) rows.push(emailLink(contact.email));
  for (const phone of [contact.phone, contact.phoneSecondary]) {
    if (phone) rows.push(`<a href="tel:${escapeHtml(telHref(phone))}">${escapeHtml(phone)}</a>`);
  }
  if (contact.whatsapp) {
    rows.push(`<a href="https://wa.me/${escapeHtml(digitsOf(contact.whatsapp))}" rel="noopener" target="_blank">${escapeHtml(messages['common.whatsapp'])}</a>`);
  }
  if (rows.length === 0) return '';
  return `<section class="bk-card bk-contact"><h2>${escapeHtml(messages['common.contactTitle'])}</h2>`
    + `<p class="bk-sub">${rows.join(' · ')}</p></section>`;
}

// A long-form message with a little structure: a blank line starts a paragraph, and consecutive
// "- " lines become one list. Escaped line by line before any markup is added, so copy from config
// never becomes HTML. A message with neither renders exactly as the single paragraph it always was.
export function messageHtml(message: string, paragraphClass?: string): string {
  const open = paragraphClass ? `<p class="${paragraphClass}">` : '<p>';
  const lines = message.split(/\r?\n/);
  const isListItem = (line: string): boolean => line.startsWith('- ');
  const isBlank = (line: string): boolean => line.trim() === '';
  if (!lines.some((line) => isListItem(line) || isBlank(line))) return `${open}${escapeHtml(message)}</p>`;
  const html: string[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) html.push(`${open}${escapeHtml(paragraph.join('\n'))}</p>`);
    if (items.length > 0) html.push(`<ul class="bk-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`);
    paragraph = [];
    items = [];
  };
  for (const line of lines) {
    if (isBlank(line)) {
      flush();
    } else if (isListItem(line)) {
      if (paragraph.length > 0) flush();
      items.push(line.slice(2).trim());
    } else {
      if (items.length > 0) flush();
      paragraph.push(line);
    }
  }
  flush();
  return html.length > 0 ? html.join('') : `${open}</p>`;
}

// Public styling hooks: consumers scope rules per page and per status with these instead of
// relying on markup order, so the names are kept stable across minor versions.
export type PageKind = 'confirmation' | 'manage' | 'admin' | 'settings';

export interface PageShellOptions {
  lang: string;
  // Rendered as `bk-page--<page>` on <body>.
  page: PageKind;
  // Rendered as `data-bk-status` on <body>: the confirmation state or the booking's status.
  status?: string | undefined;
  title: string;
  cssHref: string;
  body: string;
  // Raw HTML rendered inside the dark masthead band; caller escapes. Customer-facing pages.
  header?: string;
  // App-shell sidebar for operator surfaces; wins over `header` if both are set. Caller escapes.
  sidebar?: string;
  // Content column width for masthead pages: default 44rem, mid 56rem, wide 72rem.
  width?: 'mid' | 'wide';
  // Extra raw head markup (e.g. the confirmation page's meta refresh). Caller escapes.
  headExtra?: string;
  // `config.ui.faviconUrl`: the site's own icon on library-rendered pages.
  favicon?: string | undefined;
  // `config.ui.headHtml`, emitted verbatim AFTER the library stylesheet so a consumer's own rules
  // and token overrides take precedence over reserva's defaults.
  headHtml?: string | undefined;
  // External first-party module (the assetsJs route) — never inline script, for CSP.
  scriptHref?: string;
  // The viewer's forced theme, reflected onto <html data-theme> so first paint matches their
  // choice without an inline script. Absent/undefined = follow the OS (prefers-color-scheme).
  theme?: ThemePreference | undefined;
  // Pre-built theme-toggle control (see themeToggle below); placed in the masthead or sidebar.
  themeToggle?: string;
  sidebarLabel?: string;
  skipLabel?: string;
}

// Shared document chrome for every server-rendered reserva page. Styling comes exclusively from
// the linked stylesheet (the assetsCss route) — no inline styles or scripts — so these pages work
// unchanged under a strict style-src/script-src 'self' CSP.
export function pageShell(options: PageShellOptions): string {
  const stylesheet = options.cssHref ? `<link rel="stylesheet" href="${escapeHtml(options.cssHref)}">` : '';
  const favicon = options.favicon ? `<link rel="icon" href="${escapeHtml(options.favicon)}">` : '';
  const head = `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${options.headExtra ?? ''}<title>${escapeHtml(options.title)}</title>${favicon}${stylesheet}${options.headHtml ?? ''}${options.scriptHref ? `<script type="module" src="${escapeHtml(options.scriptHref)}"></script>` : ''}</head>`;
  const htmlTag = `<html lang="${escapeHtml(options.lang)}"${options.theme ? ` data-theme="${options.theme}"` : ''}>`;
  const toggle = options.themeToggle ?? '';
  const bodyTag = `<body class="bk-page bk-page--${options.page}"${options.status ? ` data-bk-status="${escapeHtml(options.status)}"` : ''}>`;
  const skip = options.skipLabel ? `<a class="bk-skip" href="#bk-main">${escapeHtml(options.skipLabel)}</a>` : '';
  if (options.sidebar) {
    const navLabel = options.sidebarLabel ? ` aria-label="${escapeHtml(options.sidebarLabel)}"` : '';
    const content = `${skip}<div class="bk-shell"><nav class="bk-sidebar"${navLabel}>${options.sidebar}${toggle}</nav><div class="bk-shell-main"><main id="bk-main" class="bk-main bk-main--shell">${options.body}</main></div></div>`;
    return `<!doctype html>${htmlTag}${head}${bodyTag}${content}</body></html>`;
  }
  const widthClass = options.width === 'wide' ? ' bk-main--wide' : options.width === 'mid' ? ' bk-main--mid' : '';
  const innerWidthClass = options.width === 'wide' ? ' bk-masthead-inner--wide' : options.width === 'mid' ? ' bk-masthead-inner--mid' : '';
  const masthead = options.header
    ? `<header class="bk-masthead"><div class="bk-masthead-inner${innerWidthClass}">${toggle}${options.header}</div></header>`
    : '';
  const mainClass = `bk-main${widthClass}${options.header ? ' bk-main--raised' : ''}`;
  return `<!doctype html>${htmlTag}${head}${bodyTag}${skip}${masthead}<main id="bk-main" class="${mainClass}">${options.body}</main></body></html>`;
}

// Builds the per-viewer theme toggle: rendered hidden with mode + labels as data-* so the
// enhancer needs no separate i18n island. `theme` undefined renders as "System".
export function themeToggle(messages: ReservaMessages, theme: ThemePreference | undefined): string {
  const mode = theme ?? 'system';
  return `<button type="button" class="bk-theme-toggle" data-reserva-theme-toggle hidden`
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

export function statusBadge(status: string, messages: ReservaMessages): string {
  const key = `status.${status}` as keyof ReservaMessages;
  const label = (messages[key] as string | undefined) ?? status;
  const tone = statusTone[status];
  return `<span class="bk-badge${tone ? ` bk-badge--${tone}` : ''}">${escapeHtml(label)}</span>`;
}

export function factList(rows: Array<[label: string, valueHtml: string]>): string {
  const items = rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`).join('');
  return `<dl class="bk-facts">${items}</dl>`;
}
