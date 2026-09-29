// The customer pages' own route entrypoints: what the confirmation route makes of a failing status
// read, and where each manage-page form lands. Needs the component Vite pipeline because
// createRouteContext resolves virtual:reserva/runtime and virtual:reserva/config.
import type { APIContext } from 'astro';
import { afterEach, describe, expect, it } from 'vitest';
import { GET as confirmationGET } from '../../src/routes/booking-confirmation';
import { GET as manageGET, POST as managePOST } from '../../src/routes/booking/manage';
import { booking, config } from '../fixtures';
import { fakeRepository } from '../fakes';
import { componentState, FIXED_NOW } from './fixtures/runtime';
import { DEFAULT_CONTENT_SECURITY_POLICY } from '../../src/csp';
import { escapeHtml } from '../../src/http';
import { resolveMessages } from '../../src/ui/messages';

const call = (handler: (context: APIContext) => Promise<Response>, request: Request) =>
  handler({ request, locals: {} } as unknown as APIContext);

const form = (fields: Record<string, string>) => new Request('https://example.test/booking/manage', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

afterEach(() => {
  componentState.repo = fakeRepository();
  componentState.now = FIXED_NOW;
});

describe('confirmation route', () => {
  it('keeps a server error on the waiting page (and its refresh) instead of calling the booking not found', async () => {
    componentState.repo.getBookingBySessionRef = async () => { throw new Error('D1 unavailable'); };
    const response = await call(confirmationGET, new Request('https://example.test/booking-confirmation?sessionId=cs_1&attempt=3'));
    expect(response.status).toBe(500);
    const html = await response.text();
    expect(html).toContain('data-bk-status="pending"');
    expect(html).toMatch(/http-equiv="refresh" content="3;url=[^"]*attempt=4/);
  });

  it('still gives up at the attempt cap when every poll failed', async () => {
    componentState.repo.getBookingBySessionRef = async () => { throw new Error('D1 unavailable'); };
    const html = await (await call(confirmationGET, new Request('https://example.test/booking-confirmation?sessionId=cs_1&attempt=20'))).text();
    expect(html).toContain('data-bk-status="pending"');
    expect(html).not.toContain('http-equiv="refresh"');
    // The timed-out page's way forward restarts the attempt count instead of refreshing.
    expect(html).toMatch(/<a class="bk-btn[^"]*" href="[^"]*attempt=0"/);
  });

  it('reads a link with no session id as not found', async () => {
    const response = await call(confirmationGET, new Request('https://example.test/booking-confirmation'));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('data-bk-status="not_found"');
  });

  it('negotiates ?locale onto a supported locale for the page and its lang', async () => {
    const regional = await (await call(confirmationGET, new Request('https://example.test/booking-confirmation?sessionId=cs_none&locale=pt'))).text();
    expect(regional).toContain('<html lang="pt-BR"');
    const unsupported = await (await call(confirmationGET, new Request('https://example.test/booking-confirmation?sessionId=cs_none&locale=de-DE'))).text();
    expect(unsupported).toContain('<html lang="en"');
  });
});

describe('content security policy', () => {
  const inlineScript = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>/;
  const inlineStyle = /<style[\s>]|\sstyle="/;

  it('sends the strict policy on the confirmation and manage pages, which need nothing it forbids', async () => {
    const seeded = booking();
    componentState.repo = fakeRepository([seeded]);
    for (const request of [
      new Request('https://example.test/booking-confirmation?sessionId=cs_none'),
      new Request(`https://example.test/booking/manage?token=${seeded.cancelToken}`),
      new Request(`https://example.test/booking/manage?token=${seeded.operatorToken}`),
      new Request('https://example.test/booking/manage?token=not-a-token'),
    ]) {
      const response = await call(request.url.includes('manage') ? manageGET : confirmationGET, request);
      expect(response.headers.get('content-security-policy'), request.url).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
      const html = await response.text();
      expect(html, request.url).not.toMatch(inlineScript);
      expect(html, request.url).not.toMatch(inlineStyle);
    }
  });

  it('sends it on the cancelled page a customer cancel renders', async () => {
    const seeded = booking();
    componentState.repo = fakeRepository([seeded]);
    const response = await call(managePOST, form({ action: 'cancel', token: seeded.cancelToken, refund: 'none' }));
    expect(response.headers.get('content-security-policy')).toBe(DEFAULT_CONTENT_SECURITY_POLICY);
  });
});

describe('manage route', () => {
  it('asks the reschedule picker for exactly maxHorizonDays of calendar days, even across a DST change', async () => {
    // 23:30 in Lisbon's winter: 180 × 24h later is already the next local day in summer time, which
    // made `to` one day past the horizon and availability refused the whole request.
    componentState.now = '2026-01-10T23:30:00.000Z';
    const seeded = booking({ startsAt: '2026-01-20T10:00:00.000Z', endsAt: '2026-01-20T11:00:00.000Z' });
    componentState.repo = fakeRepository([seeded]);
    const html = await (await call(manageGET, new Request(`https://example.test/booking/manage?token=${seeded.cancelToken}`))).text();
    expect(html).toContain('data-from="2026-01-10"');
    expect(html).toContain('data-to="2026-07-09"');
  });

  it('renders a cancelled page straight from the customer cancel, since the link it came from is now revoked', async () => {
    const seeded = booking();
    componentState.repo = fakeRepository([seeded]);
    const response = await call(managePOST, form({ action: 'cancel', token: seeded.cancelToken, refund: 'none' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin');
    const html = await response.text();
    expect(html).toContain('data-bk-status="cancelled"');
    expect(html).toContain(seeded.reference);
    expect(html).toContain(escapeHtml(resolveMessages(config, 'en')['manage.cancelDoneRefund']));
    expect(html).toContain('<a class="bk-btn" href="https://example.test">');
    expect(html).not.toContain(seeded.cancelToken);

    // The revocation itself is unchanged: the old link is now indistinguishable from a bad one.
    const revisit = await call(manageGET, new Request(`https://example.test/booking/manage?token=${seeded.cancelToken}`));
    expect(revisit.status).toBe(403);
  });

  it('sends an operator back to the manage page after a cancel, where the booking reads as cancelled', async () => {
    const seeded = booking();
    componentState.repo = fakeRepository([seeded]);
    const response = await call(managePOST, form({ action: 'cancel', operatorToken: seeded.operatorToken, refund: 'none' }));
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('token')).toBe(seeded.operatorToken);
    const html = await (await call(manageGET, new Request(location))).text();
    expect(html).toContain('data-bk-status="cancelled"');
  });

  // The operator types major units; the refund decision must record the booking currency's minor
  // units. 19.99 × 100 is 1998.999… in floating point, so it only lands on 1999 by rounding, and a
  // KWD booking under the fixture's EUR config needs its own ×1000.
  it.each([
    ['eur', 10000, '19.99', 1999],
    ['kwd', 30000, '12.345', 12345],
  ])('records a partial refund typed as major units in %s as its minor units', async (currency, priceMinor, typed, minor) => {
    const seeded = booking({ currency, priceMinor });
    componentState.repo = fakeRepository([seeded]);
    const response = await call(managePOST, form({ action: 'cancel', operatorToken: seeded.operatorToken, refund: 'partial', refundAmount: typed }));
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBeNull();
    expect(await componentState.repo.getRefundOperationByBookingId(seeded.id)).toMatchObject({ choice: 'partial', requestedAmountCents: minor });
  });

  it.each<[string, Record<string, string>]>([
    ['a partial refund with no amount', { action: 'cancel', operatorToken: 'operator-token', refund: 'partial', refundAmount: '' }],
    ['a local time the business timezone skips', { action: 'reschedule', token: 'cancel-token', start: '2026-03-29T01:30' }],
    ['a malformed start', { action: 'reschedule', token: 'cancel-token', start: 'tomorrow' }],
    ['an unknown action', { action: 'teleport', token: 'cancel-token' }],
  ])('bounces %s back to the manage page with ?error=, not raw JSON', async (_name, fields) => {
    componentState.repo = fakeRepository([booking()]);
    const response = await call(managePOST, form(fields));
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/booking/manage');
    expect(location.searchParams.get('error')).toBe('validation_failed');
    expect(location.searchParams.get('token')).toBe(fields.operatorToken ?? fields.token);
  });
});
