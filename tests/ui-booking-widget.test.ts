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

  it('ships the new widget.noscript i18n key in the English fallback catalog', () => {
    // Catalog parity for bundled translations is covered in ui-messages.test.ts.
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
    // Plan 018 (design decision 9) re-keyed this off data-uses-meeting-point (renamed isCustom ->
    // hide) — see the dedicated describe block below for that.
    expect(widgetSource).toContain('wrap.hidden = hide;');
    expect(widgetSource).toContain('input.disabled = hide;');
    // Wired into the pickupType radios' change listener, not just fired once.
    expect(widgetSource).toMatch(/pickup\.addEventListener\('change', \(\) => \{\s*updatePrice\(form, data\);\s*syncMeetingPoints\(form\);/);
    // And run once at init, so a service whose first pickupType option is 'custom' starts correctly
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

describe('BookingWidget.astro (Plan 018 design decision 9: service-declared pickupOptions)', () => {
  it('declares the pickupOptions prop and keeps pickupTypes as a documented deprecated alias', () => {
    expect(widgetSource).toMatch(/@deprecated use `pickupOptions` instead\./);
    expect(widgetSource).toMatch(/pickupTypes\?: Array<'default' \| 'custom'>;/);
    expect(widgetSource).toMatch(/pickupOptions\?: PickupOptionProp\[\];/);
  });

  it('maps the deprecated pickupTypes alias onto pickupOptionEntries without a data-uses-meeting-point attribute', () => {
    expect(widgetSource).toContain('const pickupOptionEntries: PickupRenderOption[] = pickupOptions');
    expect(widgetSource).toContain('usesMeetingPointAttr: undefined,');
  });

  it('the declared-options path resolves label/hint fallbacks: declared value, then default/custom catalog, then the raw id (label) or omitted (hint)', () => {
    expect(widgetSource).toContain("label: option.label ?? (isDefaultOrCustomId(option.id) ? pickupCopy[option.id].label : option.id),");
    expect(widgetSource).toContain("hint: option.hint ?? (isDefaultOrCustomId(option.id) ? pickupCopy[option.id].hint : null),");
  });

  it('renders data-uses-meeting-point on the radio group AND the single-option hidden input, carrying an explicit true/false string', () => {
    expect(widgetSource).toContain('data-uses-meeting-point={option.usesMeetingPointAttr}');
    expect(widgetSource).toContain("usesMeetingPointAttr: option.usesMeetingPoint ? 'true' : 'false',");
    // The hidden input must carry the flag too: syncMeetingPoints's un-suffixed selector fallback
    // reads it there, and without it a sole non-custom usesMeetingPoint:false option would fall
    // back to the legacy id === 'custom' heuristic and wrongly show/require the group.
    expect(widgetSource).toContain('<input type="hidden" name="pickupType" value={pickupOptionEntries[0].id} data-uses-meeting-point={pickupOptionEntries[0].usesMeetingPointAttr} />');
  });

  it('client ResolvedPriceTable widens to Record<string, number[]>, and updatePrice keys off the raw selected value', () => {
    expect(widgetSource).toContain('type ResolvedPriceTable = Record<string, number[]>;');
    expect(widgetSource).not.toContain("new FormData(form).get('pickupType') === 'custom' ? 'custom' : 'default'");
    expect(widgetSource).toContain("const pickup = String(formData.get('pickupType') ?? '');");
    expect(widgetSource).toContain('data.resolvedPrices[pickup]?.[quantity]');
  });

  it('syncMeetingPoints re-keys off the checked radio\'s data-uses-meeting-point, falling back to the pickupType === \'custom\' heuristic when absent', () => {
    expect(widgetSource).toContain("const usesMeetingPoint = selected?.dataset.usesMeetingPoint;");
    expect(widgetSource).toContain("? new FormData(form).get('pickupType') === 'custom'");
    expect(widgetSource).toContain("usesMeetingPoint !== 'true';");
  });
});
