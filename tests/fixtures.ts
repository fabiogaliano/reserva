import type { Booking } from '../src/core/booking';
import type { ClientConfig, ServiceConfig } from '../src/core/config';

export const service: ServiceConfig = {
  durationMin: 60,
  turnaroundMin: 30,
  schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '09:00', lastStart: '12:00', intervalMin: 30 }],
  pricing: [
    { maxQuantity: 4, pickup: 'default', priceMinor: 10000 },
    { maxQuantity: 4, pickup: 'custom', priceMinor: 12000 },
    { maxQuantity: 8, pickup: 'default', priceMinor: 18000 },
    { maxQuantity: 8, pickup: 'custom', priceMinor: 20000 },
  ],
  occupancyFor: (quantity) => quantity > 4 ? 2 : 1,
  // Plan 023 (design decision 1): the v1 top-level meetingPoint shorthand and injected
  // DEFAULT_PICKUP_OPTIONS pair, inlined explicitly under `location` — every existing test that
  // books 'default'/'custom' keeps working unchanged.
  location: {
    meetingPoints: [{ id: 'default', label: 'Praça do Comércio', mapsUrl: 'https://maps.google.com/?q=Praca+do+Comercio' }],
    pickupOptions: [
      { id: 'default', requiresAddress: false, usesMeetingPoint: true },
      { id: 'custom', requiresAddress: true, usesMeetingPoint: false },
    ],
  },
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
  capacity: { default: 2 },
  admin: { accessTeamDomain: 'https://team.cloudflareaccess.com', accessAud: 'aud' },
  services: { vintage: service },
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
  legal: { termsUrl: 'https://example.test/terms' },
};

export function booking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 'booking-1',
    reference: 'LVT-2026-001',
    serviceSlug: 'vintage',
    quantity: 2,
    pickupType: 'default',
    pickupAddress: null,
    meetingPointId: null,
    meetingPointLabel: null,
    startsAt: '2026-06-15T09:00:00.000Z',
    endsAt: '2026-06-15T10:00:00.000Z',
    customerName: 'Ada Lovelace',
    customerEmail: 'ada@example.test',
    customerPhone: null,
    locale: 'en',
    priceMinor: 10000,
    currency: 'eur',
    status: 'confirmed',
    holdExpiresAt: null,
    paymentSessionRef: 'cs_1',
    paymentRef: 'pi_1',
    calendarEventId: null,
    metadata: null,
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
