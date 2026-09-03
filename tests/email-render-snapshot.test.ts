import { describe, expect, it, vi } from 'vitest';
import type { ResolvedClientConfig, ResolvedServiceConfig } from '../src/core/config';
import type { Booking } from '../src/core/booking';
import type { EmailBookingEvent } from '../src/core/events';
import { brevoEmail } from '../src/providers/email-brevo/index';
import { booking, config } from './fixtures';

// Captured BEFORE the mechanical extraction of
// the template system into src/email/, then left untouched by that move -- proving it
// byte-identical -- and only updated deliberately, never as an accidental side effect of a refactor.
const locationLessService: ResolvedServiceConfig = {
  durationMin: 90,
  turnaroundMin: 15,
  schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '10:00', lastStart: '16:00', intervalMin: 60 }],
  pricing: [{ maxQuantity: 6, priceMinor: 4200 }],
};

const snapshotConfig: ResolvedClientConfig = {
  ...config,
  locales: { supported: ['en', 'pt-PT'], default: 'en' },
  services: { ...config.services, cruise: locationLessService },
};

const EVENTS: EmailBookingEvent[] = [
  'booking.confirmed',
  'booking.cancelled_by_customer',
  'booking.cancelled_by_operator',
  'booking.rescheduled',
  'booking.no_show',
];

interface CapturedEmail { subject: string; htmlContent: string; textContent?: string }

async function renderAll(overrides: Partial<Booking>): Promise<Record<string, CapturedEmail>> {
  const rendered: Record<string, CapturedEmail> = {};
  const probe = brevoEmail({ apiKey: 'snapshot-key', fetch: async () => new Response('{}', { status: 201 }) });
  for (const event of EVENTS) {
    for (const recipient of probe.recipientsForEvent(event)) {
      const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
      const provider = brevoEmail({ apiKey: 'snapshot-key', fetch: request });
      await provider.sendToRecipient(recipient, event, booking(overrides), snapshotConfig);
      rendered[`${event}.${recipient}`] = JSON.parse(request.mock.calls[0]![1]!.body as string) as CapturedEmail;
    }
  }
  return rendered;
}

describe('email renderer output', () => {
  it('location-ful booking, English', async () => {
    expect(await renderAll({ serviceSlug: 'vintage', locale: 'en', pickupType: 'default', pickupAddress: null, meetingPointId: null, meetingPointLabel: null })).toMatchSnapshot();
  });

  it('location-ful booking, European Portuguese', async () => {
    expect(await renderAll({ serviceSlug: 'vintage', locale: 'pt-PT', pickupType: 'default', pickupAddress: null, meetingPointId: null, meetingPointLabel: null })).toMatchSnapshot();
  });

  it('location-less booking, English', async () => {
    expect(await renderAll({ serviceSlug: 'cruise', locale: 'en', pickupType: null, pickupAddress: null, meetingPointId: null, meetingPointLabel: null })).toMatchSnapshot();
  });

  it('location-less booking, European Portuguese', async () => {
    expect(await renderAll({ serviceSlug: 'cruise', locale: 'pt-PT', pickupType: null, pickupAddress: null, meetingPointId: null, meetingPointLabel: null })).toMatchSnapshot();
  });
});
