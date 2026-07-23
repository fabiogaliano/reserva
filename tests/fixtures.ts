import type { Booking } from '../src/core/booking';
import type { ClientConfig, TourConfig } from '../src/core/config';

export const tour: TourConfig = {
  durationMin: 60,
  turnaroundMin: 30,
  schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '09:00', lastStart: '12:00', intervalMin: 30 }],
  pricing: [
    { maxPeople: 4, pickup: 'default', priceCents: 10000 },
    { maxPeople: 4, pickup: 'custom', priceCents: 12000 },
    { maxPeople: 8, pickup: 'default', priceCents: 18000 },
    { maxPeople: 8, pickup: 'custom', priceCents: 20000 },
  ],
  occupancyFor: (people) => people > 4 ? 2 : 1,
  meetingPoint: { label: 'Praça do Comércio', mapsUrl: 'https://maps.google.com/?q=Praca+do+Comercio' },
};

export const config: ClientConfig = {
  business: {
    name: 'Example City Tours',
    shortCode: 'LVT',
    url: 'https://example.test',
    timezone: 'Europe/Lisbon',
    currency: 'eur',
    contact: { email: 'owner@example.test', phone: '+351000000000' },
  },
  fleet: { defaultCapacity: 2 },
  admin: { accessTeamDomain: 'https://team.cloudflareaccess.com', accessAud: 'aud' },
  tours: { vintage: tour },
  booking: {
    minNoticeHours: 24,
    maxHorizonDays: 180,
    holdMinutes: 35,
    cancelCutoffHours: 24,
    reschedule: { enabled: true, cutoffHours: 24 },
    limitedThreshold: 2,
    calendarMaxStaleSeconds: 15 * 60,
  },
  locales: { supported: ['en', 'pt-BR'], default: 'en' },
  payments: { methods: ['card', 'mb_way'] },
  legal: { termsUrl: 'https://example.test/terms' },
};

export function booking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'booking-1',
    reference: 'LVT-2026-001',
    tourSlug: 'vintage',
    people: 2,
    pickupType: 'default',
    pickupAddress: null,
    startsAt: '2026-06-15T09:00:00.000Z',
    endsAt: '2026-06-15T10:00:00.000Z',
    customerName: 'Ada Lovelace',
    customerEmail: 'ada@example.test',
    customerPhone: null,
    locale: 'en',
    priceCents: 10000,
    status: 'confirmed',
    holdExpiresAt: null,
    stripeSessionId: 'cs_1',
    stripePaymentIntent: 'pi_1',
    calendarEventId: null,
    calendarSynced: false,
    emailSynced: false,
    tourflowSynced: false,
    remindedAt: null,
    reviewRequestedAt: null,
    cancelToken: 'cancel-token',
    operatorToken: 'operator-token',
    cancelledAt: null,
    cancelledBy: null,
    rescheduledFrom: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
