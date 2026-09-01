// Plan 014 item A: two instances of any exported component used to render duplicate
// `id`/`aria-labelledby` pairs (a hardcoded literal id). Renders each exported component twice and
// proves each instance's label id is unique and its own `aria-labelledby` resolves to its own id,
// not the sibling's — the actual defect a duplicate hardcoded id produces (ambiguous labelling,
// and a shared `id` is invalid HTML).
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- resolved by vitest.component.config.ts's Astro Vite pipeline, not by tsc.
import BookingWidget from '../../src/components/BookingWidget.astro';
// @ts-expect-error -- resolved by vitest.component.config.ts's Astro Vite pipeline, not by tsc.
import ManageBooking from '../../src/components/ManageBooking.astro';
// @ts-expect-error -- resolved by vitest.component.config.ts's Astro Vite pipeline, not by tsc.
import AdminDashboard from '../../src/components/AdminDashboard.astro';

// Extracts the (id, aria-labelledby) pair for a given id prefix out of one render's HTML. Every
// component under test renders exactly one labelled element whose id starts with `prefix`.
function labelPair(html: string, prefix: string): { id: string; labelledby: string } {
  const idMatch = html.match(new RegExp(`id="(${prefix}-[^"]+)"`));
  const labelledbyMatch = html.match(new RegExp(`aria-labelledby="(${prefix}-[^"]+)"`));
  if (!idMatch || !labelledbyMatch) throw new Error(`expected an id/aria-labelledby pair for prefix "${prefix}" in: ${html}`);
  return { id: idMatch[1]!, labelledby: labelledbyMatch[1]! };
}

describe('per-instance element IDs (plan 014 item A)', () => {
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
    const a = labelPair(htmlA, 'bookkit-manage-title');
    const b = labelPair(htmlB, 'bookkit-manage-title');
    expect(a.id).not.toBe(b.id);
    expect(a.labelledby).toBe(a.id);
    expect(b.labelledby).toBe(b.id);
  });

  it('AdminDashboard: two instances get distinct title ids, each aria-labelledby resolving to its own instance', async () => {
    // No Access headers wired: the h2/aria-labelledby pair renders unconditionally regardless of
    // whether the access-required notice or the form is shown (see AdminDashboard.astro).
    const container = await AstroContainer.create();
    const request = new Request('https://example.test/');
    const htmlA = await container.renderToString(AdminDashboard, { request });
    const htmlB = await container.renderToString(AdminDashboard, { request });
    const a = labelPair(htmlA, 'bookkit-admin-title');
    const b = labelPair(htmlB, 'bookkit-admin-title');
    expect(a.id).not.toBe(b.id);
    expect(a.labelledby).toBe(a.id);
    expect(b.labelledby).toBe(b.id);
  });
});
