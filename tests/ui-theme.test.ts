import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import { handleAdminGet } from '../src/handlers';
import { adminEnhancerJs } from '../src/ui/admin-enhancer';
import { pageShell, themeToggle } from '../src/ui/layout';
import { defaultMessages, type BookkitMessages } from '../src/ui/messages';
import { readThemePreference, themeCss, themeCookieName } from '../src/ui/theme';
import { config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const messages = defaultMessages as BookkitMessages;
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

  it('places the dashboard section menu in a sticky right rail on wide screens', () => {
    expect(themeCss).toContain('.bk-admin-body { grid-template-columns: minmax(0, 1fr) 11rem;');
    expect(themeCss).toContain('.bk-section-nav {\n    position: sticky;');
    expect(themeCss).toContain('.bk-section-nav a[aria-current="location"]');
  });
});

describe('admin section navigation enhancement', () => {
  it('tracks the visible section and respects reduced-motion preferences when scrolling', () => {
    expect(adminEnhancerJs).toContain("setAttribute('aria-current', 'location')");
    expect(adminEnhancerJs).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
    expect(adminEnhancerJs).toContain("scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth'");
  });
});

describe('themeToggle (server-rendered control)', () => {
  it('renders hidden, in System mode, carrying the labels the enhancer needs', () => {
    const html = themeToggle(messages, undefined);
    expect(html).toContain('data-bookkit-theme-toggle');
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
    const html = pageShell({ lang: 'en', title: 'T', cssHref: '/c', header: '<h1>Hi</h1>', body: '<p>b</p>', themeToggle: themeToggle(messages, undefined) });
    expect(html).not.toContain('data-theme=');
    expect(html).toContain('data-bookkit-theme-toggle');
  });

  it('reflects a forced theme onto <html> for a masthead page (first paint, no flash)', () => {
    const html = pageShell({ lang: 'en', title: 'T', cssHref: '/c', header: '<h1>Hi</h1>', body: '<p>b</p>', theme: 'dark', themeToggle: themeToggle(messages, 'dark') });
    expect(html).toContain('<html lang="en" data-theme="dark">');
    // The toggle sits inside the masthead band for customer-facing pages.
    expect(html).toMatch(/bk-masthead-inner[^>]*>.*data-bookkit-theme-toggle/s);
  });

  it('reflects a forced theme and mounts the toggle in the sidebar for admin shells', () => {
    const html = pageShell({ lang: 'en', title: 'T', cssHref: '/c', sidebar: '<a href="#">Nav</a>', body: '<p>b</p>', theme: 'light', themeToggle: themeToggle(messages, 'light') });
    expect(html).toContain('<html lang="en" data-theme="light">');
    expect(html).toMatch(/bk-sidebar[^>]*>.*data-bookkit-theme-toggle/s);
  });
});

describe('admin handler wiring (context.viewerTheme → rendered page)', () => {
  it('emits the toggle and reflects the cookie-derived theme on the admin page', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), clock: () => new Date('2026-06-14T08:00:00.000Z'), adminAuth: async () => ({ subject: '' }), providers: providers(), viewerTheme: 'dark' });
    const response = await handleAdminGet(new Request('https://example.test/api/booking/admin'), context);
    const body = await response.text();
    expect(body).toContain('data-theme="dark"');
    expect(body).toContain('data-bookkit-theme-toggle');
  });
});
