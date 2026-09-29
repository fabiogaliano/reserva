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

describe('BookingWidget.astro', () => {
  // The deployment's `ui.messages` overrides only reach the widget's library keys through the
  // resolved config.
  it('resolves library copy against the deployment config, not a bare catalog', () => {
    expect(widgetSource).toContain('resolveMessages(virtualConfig.config, locale)');
    expect(widgetSource).not.toContain('resolveMessages(undefined');
  });
});
