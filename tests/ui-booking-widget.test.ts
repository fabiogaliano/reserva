// BookingWidget.astro is the example site's own SFC -- no booking funnel ships in the library.
// Its markup and browser behavior are covered elsewhere; this tests source-level properties
// neither harness can observe.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const widgetPath = resolve(import.meta.dirname, '..', 'examples/smoke-site/src/components/BookingWidget.astro');
const widgetSource = readFileSync(widgetPath, 'utf8');

describe('BookingWidget.astro carries no server-owned rule of its own', () => {
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
  it('gives the availability-mode disabled submit button a loading affordance instead of a silent disable', () => {
    expect(widgetSource).toMatch(/disabled=\{usesAvailability\}[^<]*>\{usesAvailability \? t\['widget\.loadingSlots'\] : t\['widget\.submit'\]\}/);
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
