// BookingWidget.astro is the example site's own SFC -- no booking funnel ships in the library.
// Its markup and browser behavior are covered elsewhere; this tests source-level properties
// neither harness can observe, plus the message-catalog facts it depends on.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// The funnel's copy lives with the funnel: `widget.*` keys the library never renders itself moved
// out of `@reservajs/astro/ui` into the example's own catalog.
import { defaultWidgetMessages } from '../examples/smoke-site/src/components/widget-messages';

const widgetPath = resolve(import.meta.dirname, '..', 'examples/smoke-site/src/components/BookingWidget.astro');
const widgetSource = readFileSync(widgetPath, 'utf8');

describe('BookingWidget.astro carries no server-owned rule of its own', () => {
  // The drift this deletes is the one that makes a customer pay a different price than the one
  // they were shown, so the guarantee is the *absence* of any local price computation — a
  // positive test of the quote call can't prove a second path isn't there.
  it('computes no price: no price table, no currency default, no pricing import', () => {
    expect(widgetSource).not.toContain('resolvedPriceTableFor');
    expect(widgetSource).not.toContain('ResolvedPriceTable');
    expect(widgetSource).not.toContain('resolvedPrices');
    expect(widgetSource).not.toContain('priceMinor]');
    expect(widgetSource).not.toMatch(/currency = '/);
    // The single place a price appears at all: the quote response, formatted in its own currency.
    expect(widgetSource).toContain('toMajorUnits(result.priceMinor, result.currency)');
  });

  // The server gates the exact count against the deployment's limitedThreshold and publishes
  // `remaining: number | null`, so the widget renders the hint on nullness alone and holds no
  // threshold at all.
  it('applies no scarcity threshold of its own', () => {
    expect(widgetSource).toContain('if (slot.remaining !== null)');
    expect(widgetSource).not.toMatch(/^(?!\s*\/\/).*limitedThreshold/m);
    expect(widgetSource).not.toMatch(/slot\.remaining\w*\s*<=\s*/);
    expect(widgetSource).not.toContain('remainingBookings');
  });

  // Pickup ids, labels, hints and the usesMeetingPoint flag are the deployment's answer now — a
  // hardcoded default/custom pair here is exactly the folklore the catalog endpoint exists to
  // delete.
  it('hardcodes no service, pickup, or meeting-point table', () => {
    expect(widgetSource).not.toContain("'default', 'custom'");
    expect(widgetSource).not.toContain('pickupCopy');
    expect(widgetSource).not.toContain("=== 'custom'");
    expect(widgetSource).toContain('function renderLocation(');
  });

  // The widget is the library's own reference consumer, so it reads the exported wire types
  // rather than re-declaring response shapes locally — the exact duplication the first consumer
  // had to do.
  it('types every response against the exported wire types', () => {
    expect(widgetSource).toMatch(/import type \{[\s\S]*?\} from '(\.\.\/)+src\/core\/index';/);
    expect(widgetSource).not.toMatch(/interface Availability(Slot|Day|Response) \{/);
    expect(widgetSource).not.toMatch(/\{ checkoutUrl\?: string/);
  });
});

describe('BookingWidget.astro (no-JS degradation)', () => {
  it('renders a <noscript> fallback with the i18n message and an optional contact path', () => {
    expect(widgetSource).toContain('<noscript>');
    expect(widgetSource).toContain("t['widget.noscript']");
    expect(widgetSource).toContain('contactEmail');
    expect(widgetSource).toContain('contactPhone');
  });

  it('gives the availability-mode disabled submit button a loading affordance instead of a silent disable', () => {
    expect(widgetSource).toMatch(/disabled=\{usesAvailability\}[^<]*>\{usesAvailability \? t\['widget\.loadingSlots'\] : t\['widget\.submit'\]\}/);
  });

  it('ships the widget.noscript i18n key in the example widget catalog', () => {
    // `'widget.noscript' in defaultWidgetMessages` (not toHaveProperty, which treats the dot as a
    // nested path) checks the literal flat key this catalog actually uses.
    expect('widget.noscript' in defaultWidgetMessages).toBe(true);
    expect(typeof defaultWidgetMessages['widget.noscript']).toBe('string');
    expect(defaultWidgetMessages['widget.noscript'].length).toBeGreaterThan(0);
  });
});

describe('BookingWidget.astro', () => {
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

  // The deployment's `ui.messages` overrides only reach the widget's library keys through the
  // resolved config.
  it('resolves library copy against the deployment config, not a bare catalog', () => {
    expect(widgetSource).toContain('resolveMessages(virtualConfig.config, locale)');
    expect(widgetSource).not.toContain('resolveMessages(undefined');
  });
});
