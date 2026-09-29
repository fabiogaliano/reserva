import { describe, expect, it } from 'vitest';
import { renderCancelledPage, renderManagePage } from '../src/ui/pages/manage-page';
import { resolveMessages } from '../src/ui/messages';
import { config } from './fixtures';

const options = {
  messages: resolveMessages(config, 'en'),
  locale: 'en',
  timezone: config.business.timezone,
  currency: config.business.currency,
  businessName: config.business.name,
  businessUrl: config.business.url,
  contactConfig: config,
  now: new Date('2026-06-01T10:00:00.000Z'),
};

const booking = {
  reference: 'LVT-2026-001',
  serviceSlug: 'vintage',
  serviceTitle: 'Vintage Tour',
  start: '2026-06-15T09:00:00.000+01:00',
  end: '2026-06-15T10:00:00.000+01:00',
  quantity: 2,
  priceMinor: 10000,
  currency: 'eur',
  locale: 'en',
  status: 'confirmed',
  metadataRows: [],
};

function page(overrides: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return renderManagePage({
    role: 'customer',
    canCancel: true,
    canReschedule: true,
    // Different cutoffs, so each line is checkably its own.
    cancelDeadline: '2026-06-13T08:00:00.000Z',
    rescheduleDeadline: '2026-06-14T08:00:00.000Z',
    token: 'tok',
    booking,
    ...overrides,
  }, '/booking/manage', { ...options, ...extra });
}

describe('manage page deadlines', () => {
  it('states both deadlines while both actions are open', () => {
    const html = page({});
    expect(html).toContain('Free cancellation until Sat, 13 June 2026 at 09:00.');
    expect(html).toContain('You can reschedule online until Sun, 14 June 2026 at 09:00.');
  });

  it('says rescheduling has closed, with the contact details, in place of its form while cancel stays open', () => {
    const html = page({ canReschedule: false });
    expect(html).toContain('Online rescheduling closed on Sun, 14 June 2026 at 09:00. Contact us if you need a different time.');
    expect(html).not.toContain('data-reserva-reschedule');
    expect(html).toContain('Yes, cancel this booking');
    expect(html).toContain('mailto:owner@example.test');
  });

  it('says cancellation has closed while reschedule stays open', () => {
    const html = page({ canCancel: false });
    expect(html).toContain('Online cancellation closed on Sat, 13 June 2026 at 09:00. Contact us if you need to cancel.');
    expect(html).not.toContain('Yes, cancel this booking');
    expect(html).toContain('data-reserva-reschedule');
    expect(html).toContain('mailto:owner@example.test');
  });

  it('says nothing about rescheduling when the deployment has it switched off', () => {
    const html = page({ canReschedule: false }, { rescheduleEnabled: false });
    expect(html).not.toContain('Online rescheduling closed');
    expect(html).not.toContain('mailto:owner@example.test');
  });

  it('keeps the single combined notice when both actions are closed', () => {
    const html = page({ canCancel: false, canReschedule: false });
    expect(html).toContain('The change deadline for this booking has passed.');
    expect(html).not.toContain('Online cancellation closed');
    expect(html).not.toContain('Online rescheduling closed');
  });
});

describe('manage page error notice', () => {
  it('maps an ?error= code it does not own to the generic copy, including inherited property names', () => {
    for (const code of ['constructor', 'toString', '__proto__', 'made_up']) {
      const html = page({}, { errorCode: code });
      expect(html).toContain('Something went wrong and nothing was changed.');
    }
  });
});

describe('manage page enhancer', () => {
  it('loads the enhancer whenever the route offers it, not only when rescheduling is possible', () => {
    const html = page({ canReschedule: false }, { scriptHref: '/booking/assets/reserva.js?v=1' });
    expect(html).toContain('<script type="module" src="/booking/assets/reserva.js?v=1"></script>');
  });

  it('words the scarce-slot hint as further bookings of the party size, not seats, with a singular form', () => {
    const availability = { endpoint: '/api/booking/availability', serviceSlug: 'vintage', quantity: '2', from: '2026-06-01', to: '2026-08-30' };
    const island = (html: string) => JSON.parse(/<script type="application\/json" data-reserva-i18n>(.*?)<\/script>/.exec(html)![1]!);
    expect(island(page({}, { availability }))).toMatchObject({ limited: 'Room for {n} more bookings', limitedOne: 'Room for 1 more booking' });
    const pt = island(page({}, { availability, locale: 'pt-PT', messages: resolveMessages(config, 'pt-PT') }));
    expect(pt).toMatchObject({ limited: 'Vagas para mais {n} reservas', limitedOne: 'Vaga para mais 1 reserva' });
  });
});

describe('cancelled page', () => {
  it('confirms the cancellation with the reference, a refund note, a way to book again and the contact details', () => {
    const html = renderCancelledPage({ reference: 'LVT-2026-001', priceMinor: 10000 }, options);
    expect(html).toContain('<h1>Booking cancelled</h1>');
    expect(html).toContain('Your booking LVT-2026-001 has been cancelled.');
    expect(html).toContain('Any refund due is returned to your original payment method.');
    expect(html).toContain('<a class="bk-btn" href="https://example.test">Book again</a>');
    expect(html).toContain('mailto:owner@example.test');
    expect(html).toContain('data-bk-status="cancelled"');
  });

  it('leaves the refund note out for a free booking', () => {
    expect(renderCancelledPage({ reference: 'LVT-2026-002', priceMinor: 0 }, options)).not.toContain('refund');
  });
});
