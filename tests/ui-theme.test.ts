import { describe, expect, it } from 'vitest';
import { pageShell, themeToggle } from '../src/ui/layout';
import { defaultMessages, type ReservaMessages } from '../src/ui/messages';
import { darkTokenValues } from '../src/ui/generated/tokens';
import { readThemePreference, themeCss } from '../src/ui/theme';

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
});

describe('themeCss (OS default + forced overrides)', () => {
  it('keeps the OS media query but skips it once the viewer forces a theme', () => {
    expect(themeCss).toContain('@media screen and (prefers-color-scheme: dark)');
    expect(themeCss).toContain(':where(:root:not([data-theme]))');
  });

  it('forces the palette + color-scheme for an explicit choice', () => {
    expect(themeCss).toContain(':where(:root[data-theme="dark"])');
    expect(themeCss).toContain(':where(:root[data-theme="light"]) { color-scheme: light; }');
    // The dark palette is single-sourced, so the OS-dark and forced-dark blocks carry every dark token.
    const block = (selector: string): string => {
      const start = themeCss.indexOf(`${selector} {`);
      expect(start).toBeGreaterThan(-1);
      return themeCss.slice(start, themeCss.indexOf('}', start));
    };
    const osDark = block(':where(:root:not([data-theme]))');
    const forcedDark = block(':where(:root[data-theme="dark"])');
    expect(Object.keys(darkTokenValues)).toContain('--bk-accent');
    for (const [name, value] of Object.entries(darkTokenValues)) {
      expect(osDark).toContain(`${name}: ${value};`);
      expect(forcedDark).toContain(`${name}: ${value};`);
    }
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

  // Load bars and legend marks are classed, not inline-styled: a style attribute is blocked under
  // the strict style-src the pages are meant to run under, which would leave every bar empty.
  it('draws load bars and the legend through classes and keeps the row chevron on the name line when narrow', () => {
    for (const tenths of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      expect(themeCss).toContain(`.bk-meter[data-fill="${tenths}"] i { width: ${tenths}%; }`);
    }
    expect(themeCss).toContain('.bk-legend-swatch { display: inline-block;');
    expect(themeCss).toContain('.bk-legend-swatch--full { background: var(--bk-warning); }');
    expect(themeCss).toContain('.bk-legend-ring { display: inline-block;');
    expect(themeCss).toContain('.bk-legend-strike { color: var(--bk-danger); text-decoration: line-through;');
    expect(themeCss).toContain('.bk-booking-guests { grid-row: 2; grid-column: 2; }');
    expect(themeCss).toContain('.bk-booking-status { grid-row: 3; grid-column: 2; justify-self: start; justify-content: flex-start; }');
    expect(themeCss).toContain('.bk-booking-chevron { grid-row: 1; grid-column: 3; }');
    // Adjusted and closed must not differ by hue alone: one is a ring, the other a struck-through day.
    expect(themeCss).toContain('.bk-day--adjusted { box-shadow: inset 0 0 0 1px var(--bk-warning); }');
    expect(themeCss).toContain('.bk-day--closed .bk-day-num { text-decoration: line-through;');
    // Hovering the selected day must not repaint its inverted fill.
    expect(themeCss).toContain('a.bk-day:not(.bk-day--selected):hover { background: var(--bk-surface-2); }');
    // A same-specificity rule later in the sheet would silently win, so each of these must be declared once.
    expect(themeCss.match(/^\.bk-days \{/gm)).toHaveLength(1);
    expect(themeCss.match(/^\.bk-modified \{/gm)).toHaveLength(1);
    expect(themeCss.match(/^\.bk-pager \{/gm)).toHaveLength(1);
    expect(themeCss.match(/^\.bk-meter \{/gm)).toHaveLength(1);
    expect(themeCss.match(/^\.bk-daylist \{/gm)).toHaveLength(1);
  });

  // A field tag is a value, not a state, so it must never borrow the status badges' dot or tone.
  it('draws field tags without a status dot, in the body colour with a hairline border', () => {
    expect(themeCss).toContain('.bk-badge--field { color: var(--bk-text); border-color: var(--bk-border); }');
    expect(themeCss).toContain('.bk-badge--field::before { content: none; }');
  });
});

describe('themeToggle (server-rendered control)', () => {
  it('reflects the viewer\'s forced choice as the pressed button', () => {
    expect(themeToggle(messages, 'dark')).toContain('value="dark" aria-pressed="true"');
    expect(themeToggle(messages, 'dark')).toContain('value="system" aria-pressed="false"');
    expect(themeToggle(messages, 'light')).toContain('value="light" aria-pressed="true"');
  });
});

describe('pageShell (data-theme + toggle placement)', () => {
  it('reflects a forced theme and mounts the toggle in the top bar for admin shells', () => {
    const html = pageShell({ lang: 'en', page: 'admin', title: 'T', cssHref: '/c', topbar: '<a href="#">Nav</a>', body: '<p>b</p>', theme: 'light', themeToggle: themeToggle(messages, 'light') });
    expect(html).toContain('<html lang="en" data-theme="light">');
    expect(html).toMatch(/<header class="bk-topbar"><a href="#">Nav<\/a><div class="bk-theme-toggle"[^>]*data-reserva-theme-toggle/);
  });
});
