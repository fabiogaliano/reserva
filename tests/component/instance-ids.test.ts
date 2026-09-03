// Two instances of any exported component used to render duplicate `id`/`aria-labelledby` pairs
// (a hardcoded literal id). Renders each twice and proves each instance's label id is unique and
// its `aria-labelledby` resolves to its own id, not the sibling's.
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- resolved by the 'component' project's Astro Vite pipeline, not by tsc.
import BookingWidget from '../../examples/smoke-site/src/components/BookingWidget.astro';
// @ts-expect-error -- resolved by the 'component' project's Astro Vite pipeline, not by tsc.
import ManageBooking from '../../src/components/ManageBooking.astro';

// Extracts the (id, aria-labelledby) pair for a given id prefix out of one render's HTML. Every
// component under test renders exactly one labelled element whose id starts with `prefix`.
function labelPair(html: string, prefix: string): { id: string; labelledby: string } {
  const idMatch = html.match(new RegExp(`id="(${prefix}-[^"]+)"`));
  const labelledbyMatch = html.match(new RegExp(`aria-labelledby="(${prefix}-[^"]+)"`));
  if (!idMatch || !labelledbyMatch) throw new Error(`expected an id/aria-labelledby pair for prefix "${prefix}" in: ${html}`);
  return { id: idMatch[1]!, labelledby: labelledbyMatch[1]! };
}

describe('per-instance element IDs', () => {
  it('BookingWidget: two instances get distinct label ids, each aria-labelledby resolving to its own instance', async () => {
    const container = await AstroContainer.create();
    const props = { serviceSlug: 'oldTown', availabilityFrom: '2026-01-01', availabilityTo: '2026-01-02' };
    const htmlA = await container.renderToString(BookingWidget, { props });
    const htmlB = await container.renderToString(BookingWidget, { props });
    const a = labelPair(htmlA, 'bkw-date-label');
    const b = labelPair(htmlB, 'bkw-date-label');
    expect(a.id).not.toBe(b.id);
    expect(a.labelledby).toBe(a.id);
    expect(b.labelledby).toBe(b.id);
  });

  it('ManageBooking: two instances get distinct title ids, each aria-labelledby resolving to its own instance', async () => {
    const container = await AstroContainer.create();
    const htmlA = await container.renderToString(ManageBooking, {});
    const htmlB = await container.renderToString(ManageBooking, {});
    const a = labelPair(htmlA, 'reserva-manage-title');
    const b = labelPair(htmlB, 'reserva-manage-title');
    expect(a.id).not.toBe(b.id);
    expect(a.labelledby).toBe(a.id);
    expect(b.labelledby).toBe(b.id);
  });
});
