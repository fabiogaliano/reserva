// BookingWidget.astro is an Astro SFC. Its rendered markup is asserted against the real compiler
// in tests/component/booking-widget-catalog.test.ts, and its browser behavior end-to-end in
// tests/e2e; what's left here are the source-level properties neither harness can observe — that
// the client bundle contains no pricing or scarcity rule of its own — plus the message-catalog and
// CSS facts the component depends on.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultMessages } from '../src/ui/messages';

const widgetPath = resolve(import.meta.dirname, '..', 'src/components/BookingWidget.astro');
const widgetSource = readFileSync(widgetPath, 'utf8');
const componentsCssPath = resolve(import.meta.dirname, '..', 'src/ui/components.css');
const componentsCssSource = readFileSync(componentsCssPath, 'utf8');

describe('BookingWidget.astro carries no server-owned rule of its own (plan 027)', () => {
  // Plan 027 (design decision 1): the drift this deletes is the one that makes a customer pay a
  // different price than the one they were shown, so the guarantee is the *absence* of any local
  // price computation — a positive test of the quote call can't prove a second path isn't there.
  it('computes no price: no price table, no currency default, no pricing import', () => {
    expect(widgetSource).not.toContain('resolvedPriceTableFor');
    expect(widgetSource).not.toContain('ResolvedPriceTable');
    expect(widgetSource).not.toContain('resolvedPrices');
    expect(widgetSource).not.toContain('priceMinor]');
    expect(widgetSource).not.toMatch(/currency = '/);
    // The single place a price appears at all: the quote response, formatted in its own currency.
    expect(widgetSource).toContain('toMajorUnits(result.priceMinor, result.currency)');
  });

  // Plan 027 (design decision 4): the server gates the exact count against the deployment's
  // limitedThreshold and publishes `remaining: number | null`, so the widget renders the hint on
  // nullness alone and holds no threshold at all.
  it('applies no scarcity threshold of its own', () => {
    expect(widgetSource).toContain('if (slot.remaining !== null)');
    expect(widgetSource).not.toMatch(/^(?!\s*\/\/).*limitedThreshold/m);
    expect(widgetSource).not.toMatch(/slot\.remaining\w*\s*<=\s*/);
    expect(widgetSource).not.toContain('remainingBookings');
  });

  // Plan 027 (design decision 6): pickup ids, labels, hints and the usesMeetingPoint flag are the
  // deployment's answer now — a hardcoded default/custom pair here is exactly the folklore the
  // catalog endpoint exists to delete.
  it('hardcodes no service, pickup, or meeting-point table', () => {
    expect(widgetSource).not.toContain("'default', 'custom'");
    expect(widgetSource).not.toContain('pickupCopy');
    expect(widgetSource).not.toContain("=== 'custom'");
    expect(widgetSource).toContain('function renderLocation(');
  });

  // Plan 027 (design decision 2): the widget is the library's own reference consumer, so it reads
  // the exported wire types rather than re-declaring response shapes locally — the exact
  // duplication the first consumer had to do.
  it('types every response against the exported wire types', () => {
    expect(widgetSource).toMatch(/import type \{[\s\S]*?\} from '\.\.\/core\/api';/);
    expect(widgetSource).not.toMatch(/interface Availability(Slot|Day|Response) \{/);
    expect(widgetSource).not.toMatch(/\{ checkoutUrl\?: string/);
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

  // Plan 027: init is asynchronous now (it awaits the catalog before binding listeners), so the
  // reveal must still happen only after every step succeeded — a rejected init leaves the
  // fallback, with its contact details, in place.
  it('reveals the form only after the awaited init resolves, and keeps the fallback up when it rejects', () => {
    expect(widgetSource).toMatch(/await loadCatalog\(form, data\);/);
    expect(widgetSource).toMatch(/void initInstance\([\s\S]*?\)\.catch\(/);
    expect(widgetSource).toContain('its fallback stays visible');
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
  it('ships the widget.meetingPoint legend key in the shipped English catalog', () => {
    expect('widget.meetingPoint' in defaultMessages).toBe(true);
    expect(typeof defaultMessages['widget.meetingPoint']).toBe('string');
    expect(defaultMessages['widget.meetingPoint'].length).toBeGreaterThan(0);
  });

  it('toggles the group on pickupType change and at init, disabling (not just hiding) its inputs so they drop out of FormData', () => {
    expect(widgetSource).toContain('function syncMeetingPoints(form: HTMLFormElement): void {');
    expect(widgetSource).toContain('wrap.hidden = hide;');
    expect(widgetSource).toContain('input.disabled = hide;');
    // Wired into the pickupType radios' change listener, not just fired once.
    expect(widgetSource).toMatch(/pickup\.addEventListener\('change', \(\) => \{\s*void updatePrice\(form, data\);\s*syncMeetingPoints\(form\);/);
    // And run once at init, so a service whose first pickup option doesn't use a meeting point
    // starts correctly hidden instead of only reacting to a later change event.
    expect(widgetSource).toMatch(/void updatePrice\(form, data\);\s*syncMeetingPoints\(form\);\s*void loadAvailability\(form, data\);/);
  });

  it('a disabled meeting-point group actually renders display:none — the .bkw-field display:block rule does not silently win the cascade over [hidden] the way it did for .bk-widget in plan 014', () => {
    expect(componentsCssSource).toMatch(/\.bk-widget \.bkw-field\[hidden\] \{ display: none; \}/);
  });

  it('submit payload includes meetingPointId only when FormData actually carries it, never an empty string', () => {
    expect(widgetSource).toContain("const meetingPointId = formData.get('meetingPointId');");
    expect(widgetSource).toContain('if (meetingPointId !== null) payload.meetingPointId = String(meetingPointId);');
  });
});
