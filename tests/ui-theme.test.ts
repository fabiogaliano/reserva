import { describe, expect, it } from 'vitest';
import { adminEnhancerJs } from '../src/ui/admin-enhancer';
import { settingsEnhancerJs } from '../src/ui/settings-enhancer';
import { pageShell, themeToggle } from '../src/ui/layout';
import { defaultMessages, type ReservaMessages } from '../src/ui/messages';
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

  // The cell only shows a bar, so the day card is where the units figure has to reappear once
  // the enhancer takes over rendering it.
  it('renders the day peak in units and its load bar in the day card from the island', () => {
    expect(adminEnhancerJs).toContain('fill(i18n.peak, { peak: meta[2], capacity })');
    expect(adminEnhancerJs).toContain('meter.dataset.fill = String(meterFill(meta[2], capacity));');
  });

  // Same classes, title and order as the server's day panel, so a re-selected day looks unchanged.
  it('rebuilds a day row\'s field tags and money badges from the island, ahead of its status', () => {
    const tags = adminEnhancerJs.indexOf("for (const tag of row.b || [])");
    expect(tags).toBeGreaterThan(-1);
    expect(adminEnhancerJs).toContain("el('span', 'bk-badge' + (tag.m ? ' bk-badge--' + tag.m : ''), tag.t)");
    expect(adminEnhancerJs).toContain('if (tag.h) badge.title = tag.h;');
    expect(tags).toBeLessThan(adminEnhancerJs.indexOf('if (row.s) end.append('));
  });
});

describe('admin settings enhancement', () => {
  // Save is the step operators miss: an edit flags its field, and the section's save bar wakes
  // up, counts the edits and offers Discard until they land; the bar stays in view while the
  // section scrolls.
  it('flags unsaved edits on the field and the sticky save bar, and guards navigation', () => {
    expect(settingsEnhancerJs).toContain("panels.addEventListener('input'");
    expect(settingsEnhancerJs).toContain("field.querySelector('.bk-sfield-dirty')?.removeAttribute('hidden')");
    expect(settingsEnhancerJs).toContain("bar.toggleAttribute('data-dirty', count > 0);");
    expect(settingsEnhancerJs).toContain('if (save) save.disabled = count === 0;');
    expect(settingsEnhancerJs).toContain('if (discard) discard.hidden = count === 0;');
    expect(settingsEnhancerJs).toContain("panels.addEventListener('reset'");
    expect(settingsEnhancerJs).toContain("window.addEventListener('beforeunload'");
    expect(themeCss).toContain('.bk-savebar {\n  position: sticky;');
    expect(themeCss).toContain('.bk-savebar[data-dirty] {');
    // The badge's own display would otherwise beat the hidden attribute.
    expect(themeCss).toContain('.bk-sfield-dirty[hidden] { display: none; }');
    expect(themeCss).toContain('.bk-savebar [hidden] { display: none; }');
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
