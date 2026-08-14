import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createBookkitContext } from '../src/context';
import { handleManage } from '../src/handlers';
import { renderManagePage } from '../src/components/manage-page';
import { utcToLocalIso } from '../src/core/time';
import { booking, config, tour } from './fixtures';
import { fakeRepository, providers } from './fakes';

const clock = () => new Date('2026-06-14T08:00:00.000Z');

function manageContext(seed: ReturnType<typeof booking>[]) {
  return createBookkitContext({
    config,
    db: {} as D1Database,
    repo: fakeRepository(seed),
    clock,
    providers: providers(),
  });
}

function manageRequest(token?: string): Request {
  const url = new URL('https://example.test/api/booking/manage');
  if (token !== undefined) url.searchParams.set('token', token);
  return new Request(url);
}

// Spec §11: GET /manage is one page serving two capability sets from the same
// token lookup — customer tokens enforce the cancel/reschedule cutoff, operator
// tokens don't (they can also mark no-show once the tour has started).
describe('GET /manage (spec §11)', () => {
  it('customer token outside the cutoff can cancel and reschedule, and reports the booking summary + deadline', async () => {
    const seeded = booking({
      id: 'b-manage-customer-open',
      startsAt: '2026-06-15T09:00:00.000Z',
      endsAt: '2026-06-15T10:00:00.000Z',
      customerPhone: '+351111111111',
      pickupAddress: 'Rua do Arsenal 1, Lisbon',
    });
    const context = manageContext([seeded]);

    const response = await handleManage(manageRequest(seeded.cancelToken), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.role).toBe('customer');
    expect(payload.canCancel).toBe(true);
    expect(payload.canReschedule).toBe(true);
    expect(payload.canNoShow).toBe(false);
    // Deadline is startsAt minus the configured cancel cutoff, independent of "now".
    expect(payload.deadline).toBe('2026-06-14T09:00:00.000Z');
    expect(payload.booking).toMatchObject({
      reference: seeded.reference,
      tourSlug: seeded.tourSlug,
      people: seeded.people,
      pickupType: seeded.pickupType,
      pickupAddress: seeded.pickupAddress,
      start: utcToLocalIso(seeded.startsAt, config.business.timezone),
      end: utcToLocalIso(seeded.endsAt, config.business.timezone),
      locale: seeded.locale,
      priceCents: seeded.priceCents,
      customerName: seeded.customerName,
      customerEmail: seeded.customerEmail,
      customerPhone: seeded.customerPhone,
      status: seeded.status,
      // Plan 017 (design decision 3): the validated fixture config has no meetingPoint shorthand
      // left on it (normalized into meetingPoints by validateConfig) — this booking has no stored
      // meetingPointId, so bookingSummary resolves it to the tour's single declared point.
      meetingPoint: { label: tour.meetingPoint!.label, mapsUrl: tour.meetingPoint!.mapsUrl },
    });
  });

  it('resolves the summary\'s meetingPoint per booking: a chosen second point, and a stored-label fallback for a since-removed id', async () => {
    const points = [
      { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
      { id: 'station', label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' },
    ];
    const { meetingPoint: _meetingPoint, ...vintageWithoutShorthand } = tour;
    const multiPointConfig = { ...config, tours: { ...config.tours, vintage: { ...vintageWithoutShorthand, meetingPoints: points } } };

    const chosenSecond = booking({
      id: 'b-manage-meeting-point-chosen', cancelToken: 'cancel-meeting-point-chosen', operatorToken: 'operator-meeting-point-chosen',
      startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z',
      meetingPointId: 'station', meetingPointLabel: 'The Station',
    });
    const removedId = booking({
      id: 'b-manage-meeting-point-removed', cancelToken: 'cancel-meeting-point-removed', operatorToken: 'operator-meeting-point-removed',
      startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z',
      meetingPointId: 'no-longer-declared', meetingPointLabel: 'The Old Dock',
    });
    const context = createBookkitContext({
      config: multiPointConfig,
      db: {} as D1Database,
      repo: fakeRepository([chosenSecond, removedId]),
      clock,
      providers: providers(),
    });

    const chosenResponse = await handleManage(manageRequest(chosenSecond.cancelToken), context);
    const chosenPayload = await chosenResponse.json() as { booking: { meetingPoint: unknown } };
    expect(chosenPayload.booking.meetingPoint).toEqual({ label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' });

    const removedResponse = await handleManage(manageRequest(removedId.cancelToken), context);
    const removedPayload = await removedResponse.json() as { booking: { meetingPoint: unknown } };
    expect(removedPayload.booking.meetingPoint).toEqual({ label: 'The Old Dock', mapsUrl: null });
  });

  // Plan 018 (design decision 8): the manage page can't know from the raw id whether an address or
  // meeting point applies, so the summary carries the chosen option's two flags and the renderer
  // gates each fact on them independently.
  describe('pickup option flags (plan 018 design decision 8)', () => {
    const points = [
      { id: 'square', label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
      { id: 'station', label: 'The Station', mapsUrl: 'https://maps.google.com/?q=station' },
    ];
    const { meetingPoint: _meetingPoint, ...vintageWithoutShorthand } = tour;
    const mazeConfig = {
      ...config,
      tours: {
        ...config.tours,
        vintage: {
          ...vintageWithoutShorthand,
          meetingPoints: points,
          pickupOptions: [
            { id: 'default', requiresAddress: false, usesMeetingPoint: true },
            { id: 'custom_pickup', requiresAddress: true, usesMeetingPoint: false },
            { id: 'custom_dropoff', requiresAddress: true, usesMeetingPoint: true },
          ],
          pricing: [
            { maxPeople: 8, pickup: 'default', priceCents: 18000 },
            { maxPeople: 8, pickup: 'custom_pickup', priceCents: 20000 },
            { maxPeople: 8, pickup: 'custom_dropoff', priceCents: 21000 },
          ],
        },
      },
    };

    function mazeContext(seed: ReturnType<typeof booking>[]) {
      return createBookkitContext({ config: mazeConfig, db: {} as D1Database, repo: fakeRepository(seed), clock, providers: providers() });
    }

    it('reports the declared option\'s requiresAddress/usesMeetingPoint in the summary', async () => {
      const seeded = booking({
        id: 'b-manage-pickup-flags', cancelToken: 'cancel-pickup-flags', operatorToken: 'operator-pickup-flags',
        startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z',
        pickupType: 'custom_pickup', pickupAddress: 'Hotel Mundial, Lisbon',
      });
      const response = await handleManage(manageRequest(seeded.cancelToken), mazeContext([seeded]));
      const payload = await response.json() as { booking: Record<string, unknown> };
      expect(payload.booking).toMatchObject({ pickupRequiresAddress: true, pickupUsesMeetingPoint: false });
    });

    it('degrades an undeclared stored id to the pre-018 flags (address iff the literal custom id, meeting point shown)', async () => {
      const seeded = booking({
        id: 'b-manage-pickup-undeclared', cancelToken: 'cancel-pickup-undeclared', operatorToken: 'operator-pickup-undeclared',
        startsAt: '2026-06-20T09:00:00.000Z', endsAt: '2026-06-20T10:00:00.000Z',
        pickupType: 'no_longer_declared', pickupAddress: null,
      });
      const response = await handleManage(manageRequest(seeded.cancelToken), mazeContext([seeded]));
      const payload = await response.json() as { booking: Record<string, unknown> };
      expect(payload.booking).toMatchObject({ pickupRequiresAddress: false, pickupUsesMeetingPoint: true });
    });

    it('renderManagePage gates the address and meeting-point facts on the flags, independently', () => {
      const base = {
        reference: 'LVT-2026-800', tourSlug: 'vintage', start: '2026-06-20T09:00', people: 2, status: 'confirmed',
        pickupAddress: 'Hotel Mundial, Lisbon', meetingPoint: { label: 'The Square', mapsUrl: 'https://maps.google.com/?q=square' },
      };
      const addressOnly = renderManagePage({
        booking: { ...base, pickupType: 'custom_pickup', pickupRequiresAddress: true, pickupUsesMeetingPoint: false },
      }, '/manage');
      expect(addressOnly).toContain('Hotel Mundial, Lisbon');
      expect(addressOnly).not.toContain('The Square');

      const bothFlags = renderManagePage({
        booking: { ...base, pickupType: 'custom_dropoff', pickupRequiresAddress: true, pickupUsesMeetingPoint: true },
      }, '/manage');
      expect(bothFlags).toContain('Hotel Mundial, Lisbon');
      expect(bothFlags).toContain('The Square');

      // A payload without the flags (a direct caller predating them) keeps the pre-018 behavior:
      // address only for the literal 'custom' id, meeting point whenever one resolved.
      const legacy = renderManagePage({ booking: { ...base, pickupType: 'custom' } }, '/manage');
      expect(legacy).toContain('Hotel Mundial, Lisbon');
      expect(legacy).toContain('The Square');
      const legacyNonCustom = renderManagePage({ booking: { ...base, pickupType: 'default' } }, '/manage');
      expect(legacyNonCustom).not.toContain('Hotel Mundial, Lisbon');
    });
  });

  it('customer token inside the cutoff cannot cancel or reschedule', async () => {
    // Deadline (startsAt - 24h) is 2026-06-13T20:00Z, already before the clock.
    const seeded = booking({ id: 'b-manage-customer-cutoff', startsAt: '2026-06-14T20:00:00.000Z', endsAt: '2026-06-14T21:00:00.000Z' });
    const context = manageContext([seeded]);

    const response = await handleManage(manageRequest(seeded.cancelToken), context);
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.canCancel).toBe(false);
    expect(payload.canReschedule).toBe(false);
  });

  it('operator token inside the cutoff, confirmed, future start: cancel/reschedule are unrestricted but no-show is not yet available', async () => {
    const seeded = booking({ id: 'b-manage-operator-future', status: 'confirmed', startsAt: '2026-06-14T20:00:00.000Z', endsAt: '2026-06-14T21:00:00.000Z' });
    const context = manageContext([seeded]);

    const response = await handleManage(manageRequest(seeded.operatorToken), context);
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.role).toBe('operator');
    // Operator capability doesn't consult the cutoff at all.
    expect(payload.canCancel).toBe(true);
    expect(payload.canReschedule).toBe(true);
    expect(payload.canNoShow).toBe(false);
  });

  it('operator token past the start reports canNoShow true', async () => {
    const seeded = booking({ id: 'b-manage-operator-past', status: 'confirmed', startsAt: '2026-06-14T07:00:00.000Z', endsAt: '2026-06-14T08:00:00.000Z' });
    const context = manageContext([seeded]);

    const response = await handleManage(manageRequest(seeded.operatorToken), context);
    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.canNoShow).toBe(true);
  });

  it('rejects an unknown token with 403 forbidden', async () => {
    const context = manageContext([booking({ id: 'b-manage-unknown' })]);
    const response = await handleManage(manageRequest('no-such-token'), context);
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'forbidden' } });
  });

  it('rejects a missing token with 403 forbidden', async () => {
    const context = manageContext([]);
    const response = await handleManage(manageRequest(), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'forbidden' } });
  });

  it('checks cancel_token before operator_token: a value that matches one row\'s cancel_token and a different row\'s operator_token resolves to the cancel_token row, as customer', async () => {
    // Real rows never share a token across the two columns, but the handler's lookup order
    // (handlers/index.ts:355-357) is only observable by giving two distinct rows a shared
    // string in the two different columns.
    const shared = 'shared-token-value';
    const bookingA = booking({ id: 'b-manage-precedence-a', cancelToken: shared, operatorToken: 'op-a-token' });
    const bookingB = booking({ id: 'b-manage-precedence-b', cancelToken: 'cancel-b-token', operatorToken: shared });
    const context = manageContext([bookingA, bookingB]);

    const response = await handleManage(manageRequest(shared), context);
    expect(response.status).toBe(200);
    const payload = await response.json() as { role: string; booking: { reference: string } };
    expect(payload.role).toBe('customer');
    expect(payload.booking.reference).toBe(bookingA.reference);

    // Each token still resolves to its own role when queried directly.
    const operatorResponse = await handleManage(manageRequest('op-a-token'), context);
    const operatorPayload = await operatorResponse.json() as { role: string; booking: { reference: string } };
    expect(operatorPayload.role).toBe('operator');
    expect(operatorPayload.booking.reference).toBe(bookingA.reference);

    const customerBResponse = await handleManage(manageRequest('cancel-b-token'), context);
    const customerBPayload = await customerBResponse.json() as { role: string; booking: { reference: string } };
    expect(customerBPayload.role).toBe('customer');
    expect(customerBPayload.booking.reference).toBe(bookingB.reference);
  });
});
