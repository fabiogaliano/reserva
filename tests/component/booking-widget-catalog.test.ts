// Plan 027 (design decisions 1 and 6, step 7): the widget stopped being configured with copies of
// the deployment's own facts. It used to take `pricing`, `pickupOptions`, `pickupTypes`,
// `meetingPoints`, `currency` and `limitedThreshold` props and render a price table into its data
// island; it now reads the service's location axes from the catalog endpoint and every price from
// the quote endpoint. What this file pins is the half of that a server render can prove: nothing
// the deployment owns is baked into the HTML any more, and the endpoints that replace it are wired
// to the resolved route table. The client half (rendering those axes, fetching quotes) is browser
// behavior and is covered by tests/e2e/maze-pickup-options.spec.ts, meeting-points.spec.ts and
// location-less.spec.ts against a real deployment.
//
// Rendered through Astro's real Vite pipeline (see vitest.component.config.ts) because the widget
// is a compiled `.astro` SFC, not a text file.
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- resolved by vitest.component.config.ts's Astro Vite pipeline, not by tsc.
import BookingWidget from '../../src/components/BookingWidget.astro';

const baseProps = { serviceSlug: 'oldTown', availabilityFrom: '2026-01-01', availabilityTo: '2026-01-02', locale: 'en' };

async function render(props: Record<string, unknown> = baseProps): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(BookingWidget, { props });
}

function island(html: string): Record<string, any> {
  const match = html.match(/<script type="application\/json" data-bookkit-data>([^<]+)<\/script>/);
  if (!match?.[1]) throw new Error('widget rendered no data island');
  return JSON.parse(match[1]);
}

describe('BookingWidget.astro is catalog- and quote-driven (plan 027)', () => {
  it('ships no price table, currency, or scarcity threshold in its data island', async () => {
    const data = island(await render());
    expect(Object.keys(data).sort()).toEqual(['i18n', 'locale']);
    // The one fact the widget still needs to state itself: which language its copy is in.
    expect(data.locale).toBe('en');
  });

  it('renders no pickup or meeting-point fields server-side — only the anchors they are filled into', async () => {
    const html = await render();
    expect(html).not.toContain('name="pickupType"');
    expect(html).not.toContain('name="meetingPointId"');
    // The service's own axes could differ per deployment and per settings edit, so the markup
    // commits to nothing beyond where they go.
    expect(html).toContain('data-bookkit-pickup-slot');
    expect(html).toContain('data-bookkit-meeting-point-slot');
  });

  it('wires both new endpoints from the resolved route table, alongside checkout and availability', async () => {
    const html = await render();
    expect(html).toContain('data-catalog-endpoint="/api/booking/catalog"');
    expect(html).toContain('data-quote-endpoint="/api/booking/quote"');
    expect(html).toContain('data-endpoint="/api/booking/checkout"');
    expect(html).toContain('data-availability-endpoint="/api/booking/availability"');
  });

  it('accepts explicit endpoints for a consumer mounting the API elsewhere', async () => {
    const html = await render({ ...baseProps, catalogEndpoint: '/fr/api/catalog', quoteEndpoint: '/fr/api/quote' });
    expect(html).toContain('data-catalog-endpoint="/fr/api/catalog"');
    expect(html).toContain('data-quote-endpoint="/fr/api/quote"');
  });

  it('always renders the price element, since the deployment can always quote', async () => {
    const html = await render();
    expect(html).toContain('data-bookkit-price-value');
    // Empty until the first quote answers — never a server-guessed amount.
    expect(html).toContain('<strong class="bkw-price-value" data-bookkit-price-value></strong>');
  });

  it('carries the legends the client-rendered groups need, in the requested locale', async () => {
    const { i18n } = island(await render());
    expect(i18n.pickup).toBe('Where do we meet?');
    expect(i18n.meetingPoint).toBe('Choose a meeting point');
    const portuguese = island(await render({ ...baseProps, locale: 'pt-PT' }));
    expect(portuguese.i18n.pickup).not.toBe(i18n.pickup);
  });

  // Plan 026 (design decision 4): defaultLocale flipped pt-PT -> en — a generic library must not
  // default to Portuguese.
  it('renders English when no locale is supplied', async () => {
    const html = await render({ serviceSlug: 'oldTown', availabilityFrom: '2026-01-01', availabilityTo: '2026-01-02' });
    expect(html).toContain('aria-label="Book now"');
    expect(html).toContain('name="locale" value="en"');
  });
});
