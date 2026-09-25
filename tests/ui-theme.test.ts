import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext } from '../src/context';
import { handleAdminGet } from '../src/handlers';
import { adminEnhancerJs } from '../src/ui/admin-enhancer';
import { settingsEnhancerJs } from '../src/ui/settings-enhancer';
import { pageShell, themeToggle } from '../src/ui/layout';
import { defaultMessages, type ReservaMessages } from '../src/ui/messages';
import { readThemePreference, themeCss, themeCookieName } from '../src/ui/theme';
import { config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const messages = defaultMessages as ReservaMessages;
const cookieRequest = (cookie: string) => new Request('https://example.test/', { headers: { cookie } });

describe('readThemePreference (bk_theme cookie → forced theme)', () => {
  it('returns undefined without a cookie or a bk_theme entry, so the OS default wins', () => {
    expect(readThemePreference(new Request('https://example.test/'))).toBeUndefined();
    expect(readThemePreference(cookieRequest('other=1; unrelated=dark'))).toBeUndefined();
  });

  it('parses an explicit light/dark choice, even among other cookies', () => {
    expect(readThemePreference(cookieRequest('bk_theme=dark'))).toBe('dark');
    expect(readThemePreference(cookieRequest('bk_theme=light'))).toBe('light');
    expect(readThemePreference(cookieRequest('sid=abc; bk_theme=dark; foo=bar'))).toBe('dark');
    expect(readThemePreference(cookieRequest(' bk_theme = light '))).toBe('light');
  });

  it('rejects an unknown value instead of trusting a hand-edited cookie', () => {
    expect(readThemePreference(cookieRequest('bk_theme=neon'))).toBeUndefined();
    expect(readThemePreference(cookieRequest('bk_theme='))).toBeUndefined();
  });

  it('exposes the cookie name the enhancer writes', () => {
    expect(themeCookieName).toBe('bk_theme');
  });
});

describe('themeCss (OS default + forced overrides)', () => {
  it('keeps the OS media query but skips it once the viewer forces a theme', () => {
    expect(themeCss).toContain('@media (prefers-color-scheme: dark)');
    expect(themeCss).toContain(':root:not([data-theme])');
  });

  it('forces the palette + color-scheme for an explicit choice', () => {
    expect(themeCss).toContain(':root[data-theme="dark"]');
    expect(themeCss).toContain(':root[data-theme="light"] { color-scheme: light; }');
    // The dark palette is single-sourced, so the forced-dark selector carries the same accent token.
    expect(themeCss).toContain('--bk-accent: #7c86e2;');
  });

  it('ships the toggle styling, including the [hidden] guard for the pre-enhancement button', () => {
    expect(themeCss).toContain('.bk-theme-toggle {');
    expect(themeCss).toContain('.bk-theme-toggle[hidden] { display: none; }');
  });

  it('caps the booking list at a reading measure and lets the calendar panel run wider', () => {
    expect(themeCss).toContain('.bk-panel { min-width: 0; max-width: 62rem; }');
    expect(themeCss).toContain('#bk-availability { max-width: none; }');
    // Panels are server-rendered with [hidden] on all but the current tab, so this rule is what
    // makes the no-script tab links show one panel at a time.
    expect(themeCss).toContain('.bk-panels > [hidden] { display: none; }');
  });

  // The legend dots are classed, not inline-styled: a style attribute is blocked under the strict
  // style-src the pages are meant to run under, which would leave three unlabelled blank dots.
  it('colours the calendar legend through classes and keeps the row chevron on the name line when narrow', () => {
    expect(themeCss).toContain('.bk-legend-dot--booked { background: var(--bk-accent); }');
    expect(themeCss).toContain('.bk-legend-dot--adjusted { background: transparent; box-shadow: inset 0 0 0 1px var(--bk-warning); }');
    expect(themeCss).toContain('.bk-legend-dot--closed { background: var(--bk-danger); }');
    expect(themeCss).toContain('.bk-booking-status { grid-row: 2; grid-column: 2; }');
    expect(themeCss).toContain('.bk-booking-chevron { grid-row: 1; grid-column: 3; }');
    // Adjusted and booked must not differ by dot hue alone.
    expect(themeCss).toContain('.bk-day--adjusted { color: var(--bk-text); font-weight: 600; box-shadow: inset 0 0 0 1px var(--bk-warning); }');
    // A same-specificity rule later in the sheet would silently win, so each of these must be declared once.
    expect(themeCss.match(/^\.bk-days \{/gm)).toHaveLength(1);
    expect(themeCss.match(/^\.bk-modified \{/gm)).toHaveLength(1);
    expect(themeCss.match(/^\.bk-pager \{/gm)).toHaveLength(1);
    expect(themeCss.match(/^\.bk-day-bookings \{/gm)).toHaveLength(1);
  });
});

describe('admin dashboard enhancement', () => {
  it('switches tabs in place and keeps one booking row open at a time', () => {
    expect(adminEnhancerJs).toContain("a[data-reserva-admin-tab]");
    expect(adminEnhancerJs).toContain("panel.hidden = panel.id !== wanted");
    expect(adminEnhancerJs).toContain("for (const other of bookingList.querySelectorAll('.bk-booking[open]'))");
  });

  // The note is only required once the operator has decided to resolve, so it must not be a
  // textarea sitting open on every incident at once.
  it('defers the incident resolve note until the first press of Resolve', () => {
    expect(adminEnhancerJs).toContain("[data-reserva-resolve-note]");
    expect(adminEnhancerJs).toContain('noteField.hidden = true;');
  });

  // The cell only shows a dot, so the day panel is where the units figure has to reappear once
  // the enhancer takes over rendering it.
  it('renders the per-day unit load in the day panel from the island', () => {
    expect(adminEnhancerJs).toContain('const dayLoads = i18n.loads || {};');
    expect(adminEnhancerJs).toContain('load.textContent = dayLoads[date];');
  });
});

describe('admin settings enhancement', () => {
  // Save is the step operators miss: an edit flags its field and the section's save bar until it
  // lands, and the bar stays in view while the section scrolls.
  it('flags unsaved edits on the field and the sticky save bar, and guards navigation', () => {
    expect(settingsEnhancerJs).toContain("panels.addEventListener('input'");
    expect(settingsEnhancerJs).toContain("field.querySelector('.bk-sfield-dirty')?.removeAttribute('hidden')");
    expect(settingsEnhancerJs).toContain("form.querySelector('.bk-unsaved')?.removeAttribute('hidden')");
    expect(settingsEnhancerJs).toContain("window.addEventListener('beforeunload'");
    expect(themeCss).toContain('.bk-savebar {\n  position: sticky;');
    // The badge's own display would otherwise beat the hidden attribute.
    expect(themeCss).toContain('.bk-sfield-dirty[hidden], .bk-unsaved[hidden] { display: none; }');
  });
});

describe('themeToggle (server-rendered control)', () => {
  it('renders hidden, in System mode, carrying the labels the enhancer needs', () => {
    const html = themeToggle(messages, undefined);
    expect(html).toContain('data-reserva-theme-toggle');
    expect(html).toContain('hidden');
    expect(html).toContain('data-mode="system"');
    expect(html).toContain('data-l-system="System"');
    expect(html).toContain('data-l-light="Light"');
    expect(html).toContain('data-l-dark="Dark"');
    expect(html).toContain('data-aria="Theme"');
  });

  it('reflects the viewer\'s forced choice as the initial mode', () => {
    expect(themeToggle(messages, 'dark')).toContain('data-mode="dark"');
    expect(themeToggle(messages, 'light')).toContain('data-mode="light"');
  });
});

describe('pageShell (data-theme + toggle placement)', () => {
  it('leaves <html> untouched and still mounts the toggle when the viewer follows the OS', () => {
    const html = pageShell({ lang: 'en', page: 'confirmation', title: 'T', cssHref: '/c', header: '<h1>Hi</h1>', body: '<p>b</p>', themeToggle: themeToggle(messages, undefined) });
    expect(html).not.toContain('data-theme=');
    expect(html).toContain('data-reserva-theme-toggle');
  });

  it('reflects a forced theme onto <html> for a masthead page (first paint, no flash)', () => {
    const html = pageShell({ lang: 'en', page: 'confirmation', title: 'T', cssHref: '/c', header: '<h1>Hi</h1>', body: '<p>b</p>', theme: 'dark', themeToggle: themeToggle(messages, 'dark') });
    expect(html).toContain('<html lang="en" data-theme="dark">');
    // The toggle sits inside the masthead band for customer-facing pages.
    expect(html).toMatch(/bk-masthead-inner[^>]*>.*data-reserva-theme-toggle/s);
  });

  it('reflects a forced theme and mounts the toggle in the sidebar for admin shells', () => {
    const html = pageShell({ lang: 'en', page: 'admin', title: 'T', cssHref: '/c', sidebar: '<a href="#">Nav</a>', body: '<p>b</p>', theme: 'light', themeToggle: themeToggle(messages, 'light') });
    expect(html).toContain('<html lang="en" data-theme="light">');
    expect(html).toMatch(/bk-sidebar[^>]*>.*data-reserva-theme-toggle/s);
  });
});

describe('admin handler wiring (context.viewerTheme → rendered page)', () => {
  it('emits the toggle and reflects the cookie-derived theme on the admin page', async () => {
    const context = createReservaContext({ config, db: {} as D1Database, repo: fakeRepository(), clock: () => new Date('2026-06-14T08:00:00.000Z'), adminAuth: async () => ({ subject: '' }), providers: providers(), viewerTheme: 'dark' });
    const response = await handleAdminGet(new Request('https://example.test/api/booking/admin'), context);
    const body = await response.text();
    expect(body).toContain('data-theme="dark"');
    expect(body).toContain('data-reserva-theme-toggle');
  });
});
