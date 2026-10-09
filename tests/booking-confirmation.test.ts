import { describe, expect, it } from 'vitest';
import { config } from './fixtures';
import { resolveRouteConfig } from '../src/routes-manifest';
import { confirmationPage } from '../src/ui/pages/confirmation-page';
import { formatDateTime } from '../src/ui/format';
import { escapeHtml } from '../src/http';
import { resolveMessages } from '../src/ui/messages';

const en = resolveMessages(config, 'en');

describe('booking confirmation page', () => {
  it('omits the meeting-point fact and calendar location when the payload has no meetingPoint', () => {
    const html = confirmationPage(
      { config, routeConfig: resolveRouteConfig() },
      {
        status: 'confirmed',
        booking: {
          reference: 'LVT-2026-002',
          serviceSlug: 'vintage',
          serviceTitle: 'Vintage Tour',
          start: '2026-06-15T09:00:00.000+01:00',
          end: '2026-06-15T10:00:00.000+01:00',
          quantity: 2,
          priceMinor: 21000,
          currency: 'eur',
          // meetingPoint: null for a custom_both-shaped option (requiresAddress,
          // usesMeetingPoint: false) — always present, never a missing key.
          meetingPoint: null,
          locale: 'en',
          metadataRows: [],
        },
      },
      'https://example.test/booking-confirmation?sessionId=cs_confirmed_both',
      null,
    );

    expect(html).toContain('LVT-2026-002');
    expect(html).toContain('€210.00');
    expect(html).not.toContain('Praça do Comércio');
    expect(html).not.toContain(en['common.meetingPoint']);
    const decodedHtml = html.replace(/&amp;/g, '&');
    expect(decodedHtml).not.toContain(encodeURIComponent('Praça do Comércio'));
  });

  it('renders a status-only confirmed page without a blank ticket', () => {
    const html = confirmationPage(
      { config, routeConfig: resolveRouteConfig() },
      { status: 'confirmed', booking: null },
      'https://example.test/booking-confirmation?sessionId=cs_confirmed',
      null,
    );

    expect(html).toContain(escapeHtml(en['confirmation.detailsEmailed']));
    expect(html).not.toContain('class="bk-ticket"');
    expect(html).not.toContain('bk-ticket-date');
  });

  // Tests the confirmationSummary payload's labeled metadata rows, and the
  // XSS surface — a customer-supplied text field is the first fully attacker-controlled free text
  // to reach this page, so a hostile payload must never reach the DOM unescaped.
  it('renders labeled metadata rows (boolean as the existing yes/no copy pair) and escapes a hostile value', () => {
    const xssPayload = '<script>window.__xss = true;</script>"><img src=x onerror=alert(1)>';

    const html = confirmationPage(
      { config, routeConfig: resolveRouteConfig() },
      {
        status: 'confirmed',
        booking: {
          reference: 'LVT-2026-003',
          serviceSlug: 'vintage',
          serviceTitle: 'Vintage Tour',
          start: '2026-06-15T09:00:00.000+01:00',
          end: '2026-06-15T10:00:00.000+01:00',
          quantity: 2,
          priceMinor: 10000,
          currency: 'eur',
          locale: 'en',
          meetingPoint: null,
          metadataRows: [
            { key: 'dietary_notes', label: 'Dietary notes', value: xssPayload },
            { key: 'vegetarian', label: 'Vegetarian', value: true },
          ],
        },
      },
      'https://example.test/booking-confirmation?sessionId=cs_confirmed_metadata',
      null,
    );

    expect(html).toContain('LVT-2026-003');
    expect(html).toContain('Dietary notes');
    expect(html).toContain('Vegetarian');
    expect(html).toContain(`<dd>${en['admin.on']}</dd>`);
    expect(html).not.toContain(xssPayload);
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('booking confirmation page — pending, locale and return visits', () => {
  const context = { config, routeConfig: resolveRouteConfig() };

  it('hands the pending state to the served poller: the status endpoint, the session and the attempt it is on, plus a polite live region', () => {
    const html = confirmationPage(context, { status: 'pending', booking: null }, 'https://example.test/booking-confirmation?sessionId=cs_wait&attempt=4', null);
    expect(html).toContain('data-reserva-status-poll');
    expect(html).toContain('data-endpoint="/api/booking/status"');
    expect(html).toContain('data-session-id="cs_wait"');
    expect(html).toContain('data-attempt="4"');
    expect(html).toContain('data-max="20"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/<script type="module" src="\/booking\/assets\/reserva\.js\?v=[^"]+"><\/script>/);
    // The no-script fallback stays.
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain(`<a class="bk-skip" href="#bk-main">${en['common.skipContent']}</a>`);
  });

  it('stops offering the poller once the attempt budget is spent', () => {
    const html = confirmationPage(context, { status: 'pending', booking: null }, 'https://example.test/booking-confirmation?sessionId=cs_wait&attempt=20', null);
    expect(html).not.toContain('data-reserva-status-poll');
    expect(html).not.toContain('http-equiv="refresh"');
  });

  // The header's theme toggle is revealed by the same served script, so every state loads it.
  it('loads the served script in every state, so the theme toggle works once polling is over', () => {
    for (const payload of [{ status: 'failed', booking: null }, { status: 'expired', booking: null }, { status: 'not_found', booking: null }] as const) {
      const html = confirmationPage(context, payload, 'https://example.test/booking-confirmation?sessionId=cs_done', null);
      expect(html).toContain('data-reserva-theme-toggle');
      expect(html).toMatch(/<script type="module" src="\/booking\/assets\/reserva\.js\?v=[^"]+"><\/script>/);
    }
  });

  it('negotiates the ?locale hint for states that carry no booking, and never echoes an unsupported tag into lang', () => {
    const pending = { status: 'pending', booking: null } as const;
    expect(confirmationPage(context, pending, 'https://example.test/booking-confirmation?sessionId=cs_1', 'pt')).toContain('<html lang="pt-BR"');
    expect(confirmationPage(context, pending, 'https://example.test/booking-confirmation?sessionId=cs_1', 'xx-"evil')).toContain('<html lang="en"');
  });

  it('greets a return visit past the detail window neutrally rather than promising an email that went out hours ago', () => {
    const html = confirmationPage(context, {
      status: 'confirmed',
      booking: { reference: 'LVT-2026-009', serviceTitle: 'Vintage Tour', start: '2026-06-15T09:00:00.000+01:00', end: '2026-06-15T10:00:00.000+01:00', locale: 'en' },
    }, 'https://example.test/booking-confirmation?sessionId=cs_old', null);
    expect(html).toContain(escapeHtml(en['confirmation.summaryLead']));
    expect(html).not.toContain(escapeHtml(en['confirmation.lead']));
  });

  it('names the end day on a return visit to a multi-day booking, as the full ticket does', () => {
    const html = confirmationPage(context, {
      status: 'confirmed',
      booking: { reference: 'LVT-2026-011', serviceTitle: 'Vintage Tour', start: '2026-06-15T09:00:00.000Z', end: '2026-06-17T09:00:00.000Z', locale: 'en' },
    }, 'https://example.test/booking-confirmation?sessionId=cs_multi', null);
    expect(html).toContain(formatDateTime('2026-06-17T09:00:00.000Z', 'en', config.business.timezone));
  });

  it('files the calendar download under the booking reference and business host, stamped with the page clock', () => {
    const html = confirmationPage({ ...context, clock: () => new Date('2026-06-01T10:00:00.000Z') }, {
      status: 'confirmed',
      booking: {
        reference: 'LVT-2026-010', serviceSlug: 'vintage', serviceTitle: 'Vintage Tour',
        start: '2026-06-15T09:00:00.000+01:00', end: '2026-06-15T10:00:00.000+01:00',
        quantity: 2, priceMinor: 10000, currency: 'eur', meetingPoint: null, locale: 'en', metadataRows: [],
      },
    }, 'https://example.test/booking-confirmation?sessionId=cs_ics', null);
    const ics = decodeURIComponent(/href="data:text\/calendar;charset=utf-8,([^"]+)"/.exec(html)![1]!.replace(/&amp;/g, '&'));
    expect(ics).toContain('UID:LVT-2026-010@example.test');
    expect(ics).toContain('DTSTAMP:20260601T100000Z');
  });
});
