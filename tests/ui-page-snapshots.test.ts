import { describe, expect, it } from 'vitest';
import type { StatusResponse } from '../src/core/api';
import { resolveRouteConfig } from '../src/routes-manifest';
import { confirmationPage } from '../src/ui/pages/confirmation-page';
import { renderManageErrorPage, renderManagePage } from '../src/ui/pages/manage-page';
import { resolveMessages } from '../src/ui/messages';
import { config } from './fixtures';

// The whole rendered document, per state, for a deployment that sets no page customization: any
// markup change to a customer page shows up here as a reviewable diff.
const context = { config, routeConfig: resolveRouteConfig() };
const baseUrl = 'https://example.test/booking-confirmation?sessionId=cs_1';

const fullBooking = {
  reference: 'LVT-2026-001',
  serviceSlug: 'vintage',
  serviceTitle: 'Vintage Tour',
  start: '2026-06-15T09:00:00.000+01:00',
  end: '2026-06-15T10:00:00.000+01:00',
  quantity: 2,
  priceMinor: 10000,
  currency: 'eur',
  meetingPoint: { label: 'Praça do Comércio', mapsUrl: 'https://maps.google.com/?q=Praca+do+Comercio' },
  locale: 'en',
  metadataRows: [],
};

const confirmationStates: Array<[string, StatusResponse, string]> = [
  ['pending', { status: 'pending', booking: null } as StatusResponse, baseUrl],
  ['pending, timed out', { status: 'pending', booking: null } as StatusResponse, `${baseUrl}&attempt=20`],
  ['confirmed, full booking', { status: 'confirmed', booking: fullBooking } as StatusResponse, baseUrl],
  ['confirmed, summary', {
    status: 'confirmed',
    booking: { reference: 'LVT-2026-001', serviceTitle: 'Vintage Tour', start: '2026-06-15T09:00:00.000+01:00', end: '2026-06-15T10:00:00.000+01:00', locale: 'en' },
  } as StatusResponse, baseUrl],
  ['failed', { status: 'failed', booking: null } as StatusResponse, baseUrl],
  ['expired', { status: 'expired', booking: null } as StatusResponse, baseUrl],
  ['cancelled', { status: 'cancelled', booking: null } as StatusResponse, baseUrl],
  ['not found', { status: 'not_found', booking: null } as StatusResponse, baseUrl],
];

describe('confirmation page snapshots (no customization)', () => {
  it.each(confirmationStates)('%s', (_name, payload, url) => {
    expect(confirmationPage(context, payload, url, null)).toMatchSnapshot();
  });
});

describe('manage page snapshots (no customization)', () => {
  const options = {
    messages: resolveMessages(config, 'en'),
    locale: 'en',
    timezone: config.business.timezone,
    currency: config.business.currency,
    cssHref: '/booking/assets/reserva.css?v=test',
    businessName: config.business.name,
    businessUrl: config.business.url,
    contactConfig: config,
  };

  it('confirmed booking with actions', () => {
    const payload = {
      role: 'customer',
      canCancel: true,
      canReschedule: true,
      cancelDeadline: '2026-06-14T09:00:00.000Z',
      token: 'tok',
      booking: { ...fullBooking, status: 'confirmed' },
    };
    expect(renderManagePage(payload, '/booking/manage', options)).toMatchSnapshot();
  });

  it('invalid link', () => {
    expect(renderManageErrorPage('/booking/manage', options)).toMatchSnapshot();
  });
});
