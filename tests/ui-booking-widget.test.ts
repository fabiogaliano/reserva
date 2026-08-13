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
const componentsCssPath = resolve(import.meta.dirname, '..', 'src/ui/components.css');
const componentsCssSource = readFileSync(componentsCssPath, 'utf8');

describe('BookingWidget.astro (BK-CAP-002: threshold + units)', () => {
  it('keeps the prop threshold as a static-mode fallback and prefers availability response policy', () => {
    expect(widgetSource).toMatch(/limitedThreshold\?: number;/); // Props
    expect(widgetSource).toMatch(/limitedThreshold = 3,/); // destructured with a default
    expect(widgetSource).toMatch(/const scriptData = \{[\s\S]*?limitedThreshold,[\s\S]*?\}/); // fallback island
    expect(widgetSource).toContain('interface AvailabilityResponse { days?: AvailabilityDay[]; limitedThreshold?: number; error?: { message?: string } }');
    expect(widgetSource).toContain('data.limitedThreshold = limitedThreshold');
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

describe('BookingWidget.astro (Plan 017 design decision 5: meeting-point radio group)', () => {
  it('declares the meetingPoints prop and defaults it to an empty array', () => {
    expect(widgetSource).toMatch(/meetingPoints\?: Array<\{ id: string; label: string \}>;/);
    expect(widgetSource).toMatch(/meetingPoints = \[\],/);
  });

  it('renders the group only for 2+ points, gated on data-bookkit-meeting-points, named meetingPointId, first checked', () => {
    expect(widgetSource).toContain('{meetingPoints.length >= 2 && (');
    expect(widgetSource).toContain('<fieldset class="bkw-field" data-bookkit-meeting-points>');
    expect(widgetSource).toContain("<legend class=\"bkw-label\">{t['widget.meetingPoint']}</legend>");
    expect(widgetSource).toMatch(/<input type="radio" name="meetingPointId" value=\{point\.id\} required checked=\{index === 0\} \/>/);
  });

  it('ships the widget.meetingPoint legend key in the shipped English catalog', () => {
    expect('widget.meetingPoint' in defaultMessages).toBe(true);
    expect(typeof defaultMessages['widget.meetingPoint']).toBe('string');
    expect(defaultMessages['widget.meetingPoint'].length).toBeGreaterThan(0);
  });

  it('toggles the group on pickupType change and at init, disabling (not just hiding) its inputs so they drop out of FormData', () => {
    expect(widgetSource).toContain('function syncMeetingPoints(form: HTMLFormElement): void {');
    expect(widgetSource).toContain("wrap.hidden = isCustom;");
    expect(widgetSource).toContain('input.disabled = isCustom;');
    // Wired into the pickupType radios' change listener, not just fired once.
    expect(widgetSource).toMatch(/pickup\.addEventListener\('change', \(\) => \{\s*updatePrice\(form, data\);\s*syncMeetingPoints\(form\);/);
    // And run once at init, so a tour whose first pickupType option is 'custom' starts correctly
    // hidden instead of only reacting to a later change event.
    expect(widgetSource).toMatch(/updatePrice\(form, data\);\s*syncMeetingPoints\(form\);\s*void loadAvailability\(form, data\);/);
  });

  it('a disabled meeting-point group actually renders display:none — the .bkw-field display:block rule does not silently win the cascade over [hidden] the way it did for .bk-widget in plan 014', () => {
    expect(componentsCssSource).toMatch(/\.bk-widget \.bkw-field\[hidden\] \{ display: none; \}/);
  });

  it('submit payload includes meetingPointId only when FormData actually carries it, never an empty string', () => {
    expect(widgetSource).toContain("const meetingPointId = formData.get('meetingPointId');");
    expect(widgetSource).toContain('if (meetingPointId !== null) payload.meetingPointId = String(meetingPointId);');
  });
});
