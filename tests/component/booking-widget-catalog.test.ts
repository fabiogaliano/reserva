// The widget reads the service's location axes from the catalog endpoint and every price from
// the quote endpoint, instead of taking deployment facts as props. Pins the server half: nothing
// the deployment owns is baked into the HTML, and the endpoints are wired to the resolved route
// table. The client half (rendering axes, fetching quotes) is covered by the e2e specs against a
// real deployment. Rendered through Astro's real Vite pipeline since the widget is a compiled
// `.astro` SFC, not a text file.
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- resolved by the 'component' project's Astro Vite pipeline, not by tsc.
import BookingWidget from '../../examples/smoke-site/src/components/BookingWidget.astro';
import { defaultWidgetMessages as en } from '../../examples/smoke-site/src/components/widget-messages';

const baseProps = { serviceSlug: 'oldTown', availabilityFrom: '2026-01-01', availabilityTo: '2026-01-02', locale: 'en' };

async function render(props: Record<string, unknown> = baseProps): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(BookingWidget, { props });
}

function island(html: string): Record<string, any> {
  const match = html.match(/<script type="application\/json" data-reserva-data>([^<]+)<\/script>/);
  if (!match?.[1]) throw new Error('widget rendered no data island');
  return JSON.parse(match[1]);
}

describe('BookingWidget.astro is catalog- and quote-driven', () => {
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
    expect(html).toContain('data-reserva-pickup-slot');
    expect(html).toContain('data-reserva-meeting-point-slot');
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
    expect(html).toContain('data-reserva-price-value');
    // Empty until the first quote answers — never a server-guessed amount.
    expect(html).toContain('<strong class="bkw-price-value" data-reserva-price-value></strong>');
  });

  it('carries the legends the client-rendered groups need, in the requested locale', async () => {
    const { i18n } = island(await render());
    expect(i18n.pickup).toBe(en['widget.pickup']);
    expect(i18n.meetingPoint).toBe(en['widget.meetingPoint']);
    const portuguese = island(await render({ ...baseProps, locale: 'pt-PT' }));
    expect(portuguese.i18n.pickup).not.toBe(i18n.pickup);
  });

  // The script rebuilds the options from the catalog's maxQuantity; the server render reads the
  // same config, so the markup never offers a size the service does not price.
  it('renders party sizes 1..maxQuantity of the configured service, not a fixed 1..4', async () => {
    const html = await render({ ...baseProps, serviceSlug: 'vintage' });
    const values = [...html.matchAll(/<option value="(\d+)">/g)].map((match) => Number(match[1]));
    expect(values).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(html).not.toContain('data-quantity-fixed');
  });

  it('keeps an explicit quantityOptions prop exactly as passed, and tells the script not to rebuild it', async () => {
    const html = await render({ ...baseProps, serviceSlug: 'vintage', quantityOptions: [2, 4] });
    const values = [...html.matchAll(/<option value="(\d+)">/g)].map((match) => Number(match[1]));
    expect(values).toEqual([2, 4]);
    expect(html).toContain('data-quantity-fixed');
  });

  it('carries its error copy in the requested locale', async () => {
    const { i18n } = island(await render());
    expect(i18n.errorSlotUnavailable).toBe(en['widget.errorSlotUnavailable']);
    const portuguese = island(await render({ ...baseProps, locale: 'pt-PT' }));
    for (const key of ['errorSlotUnavailable', 'errorTooManyHolds', 'errorValidation', 'errorField', 'errorCalendar', 'errorNetwork', 'limited', 'limitedOne', 'details', 'optional']) {
      expect(portuguese.i18n[key], key).toBeTruthy();
      expect(portuguese.i18n[key], key).not.toBe(i18n[key]);
    }
  });

  // defaultLocale flipped pt-PT -> en — a generic library must not default to Portuguese.
  it('renders English when no locale is supplied', async () => {
    const html = await render({ serviceSlug: 'oldTown', availabilityFrom: '2026-01-01', availabilityTo: '2026-01-02' });
    expect(html).toContain('name="locale" value="en"');
    expect(island(html).i18n.pickup).toBe(en['widget.pickup']);
  });

  // Scripting fully off never runs the script that swaps the fallback for the form, so <noscript>
  // is the only way such a visitor learns how to book.
  it('renders a <noscript> fallback with its copy, and the contact links only when contact props are passed', async () => {
    const noscript = (html: string): string => {
      const match = html.match(/<noscript>([\s\S]*?)<\/noscript>/);
      if (!match?.[1]) throw new Error('widget rendered no <noscript> block');
      return match[1];
    };
    const withContact = noscript(await render({ ...baseProps, contactEmail: 'hello@example.test', contactPhone: '+351 000 000 000' }));
    expect(en['widget.noscript'].length).toBeGreaterThan(0);
    expect(withContact).toContain(`<p>${en['widget.noscript']}</p>`);
    expect(withContact).toContain('href="mailto:hello@example.test"');
    expect(withContact).toContain('href="tel:+351 000 000 000"');
    const bare = noscript(await render());
    expect(bare).toContain(`<p>${en['widget.noscript']}</p>`);
    expect(bare).not.toContain('bkw-noscript-contact');
  });
});
