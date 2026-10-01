import type { AstroIntegration } from 'astro';
import type { Booking } from '../src/core/booking';
import type { PricingRule, ResolvedClientConfig, ResolvedServiceConfig } from '../src/core/config';

// The breakpoint rows of a service the test knows prices by rows; narrows the pricing union once.
export function rowsOf(service: { pricing: ResolvedServiceConfig['pricing'] }): PricingRule[] {
  if (!Array.isArray(service.pricing)) throw new Error('expected breakpoint pricing rows');
  return service.pricing;
}

export const service: ResolvedServiceConfig = {
  title: 'Vintage Tour',
  durationMin: 60,
  turnaroundMin: 30,
  schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '09:00', lastStart: '12:00', intervalMin: 30 }],
  scheduleSource: 'service',
  pricing: [
    { maxQuantity: 4, pickup: 'default', priceMinor: 10000 },
    { maxQuantity: 4, pickup: 'custom', priceMinor: 12000 },
    { maxQuantity: 8, pickup: 'default', priceMinor: 18000 },
    { maxQuantity: 8, pickup: 'custom', priceMinor: 20000 },
  ],
  occupancy: { seatsPerUnit: 4 },
  // The v1 top-level meetingPoint shorthand and injected DEFAULT_PICKUP_OPTIONS pair, inlined
  // explicitly under `location` — every existing test that books 'default'/'custom' keeps
  // working unchanged.
  location: {
    meetingPoints: [{ id: 'default', label: 'Praça do Comércio', mapsUrl: 'https://maps.google.com/?q=Praca+do+Comercio' }],
    pickupOptions: [
      { id: 'default', label: 'Meeting point', requiresAddress: false, usesMeetingPoint: true },
      { id: 'custom', label: 'Hotel pickup', requiresAddress: true, usesMeetingPoint: false },
    ],
  },
};

export const config: ResolvedClientConfig = {
  business: {
    name: 'Example City Tours',
    shortCode: 'LVT',
    url: 'https://example.test',
    timezone: 'Europe/Lisbon',
    currency: 'eur',
    contact: { email: 'owner@example.test', phone: '+351000000000' },
  },
  capacity: { default: 2 },
  admin: { access: { teamDomain: 'https://team.cloudflareaccess.com', aud: 'aud' } },
  pricing: { surcharges: {}, maxUnits: 1, surchargeScope: 'unit' },
  services: { vintage: service },
  booking: {
    minNoticeHours: 24,
    maxHorizonDays: 180,
    holdMinutes: 35,
    cancelCutoffHours: 24,
    reschedule: { enabled: true, cutoffHours: 24 },
    limitedThreshold: 2,
    reminderHoursBefore: 24,
    calendarMaxStaleSeconds: 15 * 60,
    maxHoldsPerIp: 5,
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
    guestCount: null,
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
    amountRefundedMinor: 0,
    disputedAt: null,
    disputeStatus: null,
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

export interface AstroConfigSetupResult {
  routes: Array<Record<string, unknown>>;
  updateConfigCalls: Array<Record<string, unknown>>;
  viteConfig: Record<string, unknown>;
}

// Takes the built integration rather than importing `reserva()` here: this file is shared with the
// workers project, which cannot load the Node/Astro build-time integration module.
export function runAstroConfigSetup(
  integration: AstroIntegration,
  command: 'dev' | 'build' | 'preview' = 'build',
): AstroConfigSetupResult {
  const routes: Array<Record<string, unknown>> = [];
  const updateConfigCalls: Array<Record<string, unknown>> = [];
  // Astro accumulates every updateConfig call (vite plugins, env schema), so merge them into one
  // view rather than keeping only the last.
  let viteConfig: Record<string, unknown> = {};
  const hook = integration.hooks['astro:config:setup'];
  if (!hook) throw new Error('setup hook is missing');
  hook({
    config: { root: new URL('../', import.meta.url) },
    command,
    isRestart: false,
    injectRoute: (route: Record<string, unknown>) => routes.push(route),
    updateConfig: (next: Record<string, unknown>) => {
      updateConfigCalls.push(next);
      viteConfig = { ...viteConfig, ...next };
      return {};
    },
    logger: { info() {}, warn() {}, error() {} },
  } as never);
  return { routes, updateConfigCalls, viteConfig };
}
