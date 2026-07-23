// BookingWidget.astro is an Astro SFC; this repo's plain `vitest.config.ts` has no Astro Vite
// plugin wired in (see vitest.config.ts / package.json — only `tsc --noEmit` + vitest run plain
// .ts), so there is no harness to actually render or execute it here. These assertions read the
// component source as text instead, proportional to what a no-render-harness repo can verify.
// A real browser/Playwright test (e.g. asserting a JS-off page shows the <noscript> message and
// never reveals the form) is a follow-up noted in the PR description — Playwright isn't a repo
// dependency today.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultMessages } from '../src/ui/messages';

const widgetPath = resolve(import.meta.dirname, '..', 'src/components/BookingWidget.astro');
const widgetSource = readFileSync(widgetPath, 'utf8');

describe('BookingWidget.astro (BK-CAP-002: threshold + units)', () => {
  it('threads limitedThreshold from props into the scriptData JSON island', () => {
    expect(widgetSource).toMatch(/limitedThreshold\?: number;/); // Props
    expect(widgetSource).toMatch(/limitedThreshold = 3,/); // destructured with a default
    expect(widgetSource).toMatch(/const scriptData = \{[\s\S]*?limitedThreshold,[\s\S]*?\}/); // fed into the island
  });

  it('declares remainingBookings on the client-side slot type and gates the scarcity hint on it, not the hardcoded 3', () => {
    expect(widgetSource).toContain('interface AvailabilitySlot { start: string; remaining: number; remainingBookings: number }');
    expect(widgetSource).toContain('interface WidgetData');
    expect(widgetSource).toMatch(/limitedThreshold: number;/); // WidgetData field
    expect(widgetSource).toContain('slot.remainingBookings > 0 && slot.remainingBookings <= data.limitedThreshold');
    // The old hardcoded gate must be gone, not just supplemented.
    expect(widgetSource).not.toMatch(/slot\.remaining\s*<=\s*3/);
  });
});

describe('BookingWidget.astro (BK-UI-001: no-JS degradation)', () => {
  it('starts the form hidden and reveals it from the enhancement script, not from markup', () => {
    expect(widgetSource).toMatch(/<form[\s\S]*?\bhidden\b[\s\S]*?>/);
    expect(widgetSource).toContain('form.hidden = false;');
  });

  it('renders a <noscript> fallback with the i18n message and an optional contact path', () => {
    expect(widgetSource).toContain('<noscript>');
    expect(widgetSource).toContain("t['widget.noscript']");
    expect(widgetSource).toContain('contactEmail');
    expect(widgetSource).toContain('contactPhone');
  });

  it('gives the availability-mode disabled submit button a loading affordance instead of a silent disable', () => {
    expect(widgetSource).toMatch(/disabled=\{usesAvailability\}[^<]*>\{usesAvailability \? t\['widget\.loadingSlots'\] : t\['widget\.submit'\]\}/);
  });

  it('ships the new widget.noscript i18n key in the shipped English catalog', () => {
    // messages.ts ships a single catalog (English defaults); consumers layer their own locales at
    // runtime via config.ui.messages, so "every shipped locale" here is this one file's catalog.
    // `'widget.noscript' in defaultMessages` (not toHaveProperty, which treats the dot as a nested
    // path) checks the literal flat key this catalog actually uses.
    expect('widget.noscript' in defaultMessages).toBe(true);
    expect(typeof defaultMessages['widget.noscript']).toBe('string');
    expect(defaultMessages['widget.noscript'].length).toBeGreaterThan(0);
  });
});
