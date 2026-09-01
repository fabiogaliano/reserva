import { describe, expect, it } from 'vitest';
import { DuplicatePaymentIntentError } from '../src/repo';
import { booking } from './fixtures';
import { fakeRepository } from './fakes';

const holdInput = (id: string) => ({
  id,
  reference: `LVT-2026-${id}`,
  tourSlug: 'vintage',
  people: 2,
  pickupType: 'default' as const,
  startsAt: '2026-06-20T09:00:00.000Z',
  endsAt: '2026-06-20T10:00:00.000Z',
  locale: 'en',
  priceCents: 10000,
  holdExpiresAt: '2026-06-20T09:35:00.000Z',
  cancelToken: `cancel-${id}`,
  operatorToken: `operator-${id}`,
  createdAt: '2026-06-14T08:00:00.000Z',
  updatedAt: '2026-06-14T08:01:00.000Z',
});

describe('fakeRepository fidelity to the real D1 repository', () => {
  it('keeps legacy seeded tokens usable on every hydrated read without an encryption key', async () => {
    const seeded = booking({
      id: 'b-legacy-hydration',
      reference: 'LVT-2026-LEGACY-HYDRATION',
      startsAt: '2026-06-20T09:00:00.000Z',
      updatedAt: '2026-06-14T08:01:00.000Z',
      cancelToken: 'cancel-legacy-token',
      operatorToken: 'operator-legacy-token',
    });
    const repo = fakeRepository([seeded]);

    await expect(repo.getBookingById(seeded.id)).resolves.toMatchObject({
      cancelToken: seeded.cancelToken,
      operatorToken: seeded.operatorToken,
    });
    await expect(repo.listUpcoming('2026-06-14T08:00:00.000Z')).resolves.toEqual([
      expect.objectContaining({ cancelToken: seeded.cancelToken, operatorToken: seeded.operatorToken }),
    ]);
    await expect(repo.getBookingByReference(seeded.reference)).resolves.toMatchObject({
      cancelToken: seeded.cancelToken,
      operatorToken: seeded.operatorToken,
    });
    await expect(repo.listOccupancyBookings('2026-06-20T08:00:00.000Z', '2026-06-20T10:00:00.000Z')).resolves.toEqual([
      expect.objectContaining({ cancelToken: seeded.cancelToken, operatorToken: seeded.operatorToken }),
    ]);
  });

  it('retains legacy plaintext tokens after lazy hash backfill', async () => {
    const seeded = booking({
      id: 'b-legacy-backfill',
      startsAt: '2026-06-20T09:00:00.000Z',
      updatedAt: '2026-06-14T08:01:00.000Z',
      cancelToken: 'cancel-legacy-backfill',
      operatorToken: 'operator-legacy-backfill',
    });
    const repo = fakeRepository([seeded]);

    await expect(repo.getBookingByCancelToken(seeded.cancelToken, '2026-06-14T08:00:00.000Z')).resolves.toMatchObject({ id: seeded.id });
    expect(repo.tokenState.get(seeded.id)?.cancelTokenHash).not.toBeNull();
    await expect(repo.getBookingById(seeded.id)).resolves.toMatchObject({
      cancelToken: seeded.cancelToken,
      operatorToken: seeded.operatorToken,
    });
    await expect(repo.listUpcoming('2026-06-14T08:00:00.000Z')).resolves.toEqual([
      expect.objectContaining({ cancelToken: seeded.cancelToken, operatorToken: seeded.operatorToken }),
    ]);
  });

  it('keeps new rows unpresentable on hydrated reads without an encryption key', async () => {
    const input = holdInput('new-no-key');
    const repo = fakeRepository();

    await expect(repo.insertHold(input)).resolves.toMatchObject({
      cancelToken: expect.stringMatching(/^nohash:/),
      operatorToken: expect.stringMatching(/^nohash:/),
    });
    await expect(repo.getBookingById(input.id)).resolves.toMatchObject({
      cancelToken: expect.stringMatching(/^nohash:/),
      operatorToken: expect.stringMatching(/^nohash:/),
    });
  });

  it('hydrates new rows only with an encryption key while raw reads retain placeholders', async () => {
    const input = holdInput('new-with-key');
    const repo = fakeRepository([], { tokenEncryptionKey: 'test-token-key' });

    await expect(repo.insertHold(input)).resolves.toMatchObject({
      cancelToken: input.cancelToken,
      operatorToken: input.operatorToken,
    });
    await expect(repo.getBookingById(input.id)).resolves.toMatchObject({
      cancelToken: input.cancelToken,
      operatorToken: input.operatorToken,
    });
    await expect(repo.getBookingByReference(input.reference)).resolves.toMatchObject({
      cancelToken: expect.stringMatching(/^nohash:/),
      operatorToken: expect.stringMatching(/^nohash:/),
    });
    await expect(repo.listOccupancyBookings('2026-06-20T08:00:00.000Z', '2026-06-20T10:00:00.000Z')).resolves.toEqual([
      expect.objectContaining({
        cancelToken: expect.stringMatching(/^nohash:/),
        operatorToken: expect.stringMatching(/^nohash:/),
      }),
    ]);
  });

  it('guards duplicate payment intents in every fake write path without rejecting same-booking rewrites', async () => {
    const source = booking({ id: 'b-pi-source', stripePaymentIntent: 'pi-duplicate' });
    const updateTarget = booking({ id: 'b-pi-update', stripePaymentIntent: null });
    const transitionTarget = booking({ id: 'b-pi-transition', status: 'hold', stripePaymentIntent: null });
    const paymentDetailsTarget = booking({ id: 'b-pi-details', stripePaymentIntent: null });
    const repo = fakeRepository([source, updateTarget, transitionTarget, paymentDetailsTarget]);

    await expect(repo.updateBooking(source.id, {
      stripePaymentIntent: source.stripePaymentIntent,
      updatedAt: '2026-06-14T08:01:00.000Z',
    })).resolves.toMatchObject({ stripePaymentIntent: source.stripePaymentIntent });
    await expect(repo.updateBooking(updateTarget.id, {
      stripePaymentIntent: source.stripePaymentIntent,
      updatedAt: '2026-06-14T08:01:00.000Z',
    })).rejects.toBeInstanceOf(DuplicatePaymentIntentError);
    await expect(repo.transitionToConfirmed(transitionTarget.id, {
      expectedStatusIn: ['hold'],
      stripePaymentIntent: source.stripePaymentIntent,
      updatedAt: '2026-06-14T08:01:00.000Z',
    })).rejects.toBeInstanceOf(DuplicatePaymentIntentError);

    await expect(repo.acquireConfirmationLease(paymentDetailsTarget.id, 'lease-pi-details', '2026-06-14T08:00:00.000Z', '2026-06-14T08:05:00.000Z')).resolves.toBe(true);
    await expect(repo.applyConfirmedPaymentDetails(paymentDetailsTarget.id, {
      stripePaymentIntent: source.stripePaymentIntent,
    }, 'lease-pi-details', '2026-06-14T08:01:00.000Z')).rejects.toBeInstanceOf(DuplicatePaymentIntentError);

    const emptySource = booking({ id: 'b-pi-empty-source', stripePaymentIntent: '' });
    const emptyTarget = booking({ id: 'b-pi-empty-target', stripePaymentIntent: null });
    const emptyRepo = fakeRepository([emptySource, emptyTarget]);
    await expect(emptyRepo.updateBooking(emptyTarget.id, {
      stripePaymentIntent: '',
      updatedAt: '2026-06-14T08:01:00.000Z',
    })).rejects.toBeInstanceOf(DuplicatePaymentIntentError);
  });

  it('matches real no-op and conflict-update behavior for partial booking writes', async () => {
    const seeded = booking({ id: 'b-fake-write-parity', customerEmail: 'customer@example.test', updatedAt: '2026-06-14T08:00:00.000Z' });
    const repo = fakeRepository([seeded]);

    const patch = { updatedAt: '2026-06-14T08:01:00.000Z' };
    Object.assign(patch, { customerEmail: undefined });
    const updated = await repo.updateBooking(seeded.id, patch);
    expect(updated).toMatchObject({ customerEmail: seeded.customerEmail, updatedAt: '2026-06-14T08:01:00.000Z' });

    await repo.acquireConfirmationLease(seeded.id, 'lease-fake-write-parity', '2026-06-14T08:01:00.000Z', '2026-06-14T08:06:00.000Z');
    const applied = await repo.applyConfirmedPaymentDetails(seeded.id, {}, 'lease-fake-write-parity', '2026-06-14T08:02:00.000Z');
    expect(applied).toBe(false);
    expect(repo.rows.get(seeded.id)?.updatedAt).toBe('2026-06-14T08:01:00.000Z');

    await repo.claimRefundOperation({
      id: 'op-fake-write-original', bookingId: seeded.id, paymentIntent: seeded.stripePaymentIntent, choice: 'full', requestedAt: '2026-06-14T08:00:00.000Z',
    });
    await repo.upsertRefundOperation({
      id: 'op-fake-write-replacement', bookingId: seeded.id, paymentIntent: seeded.stripePaymentIntent, choice: 'full', status: 'failed',
      stripeRefundId: null, amountCents: null, requestedAt: '2026-06-14T08:02:00.000Z', resolvedAt: '2026-06-14T08:02:00.000Z',
    });
    expect(repo.refundOperations.get(seeded.id)?.id).toBe('op-fake-write-original');
  });

  it('refuses a confirmation lease for an unknown booking id, like the real UPDATE ... WHERE id = ?', async () => {
    const repo = fakeRepository([booking({ id: 'b-known' })]);

    await expect(repo.acquireConfirmationLease('b-unknown', 'token-1', '2026-06-14T08:00:00.000Z', '2026-06-14T08:05:00.000Z')).resolves.toBe(false);
    await expect(repo.acquireConfirmationLease('b-known', 'token-1', '2026-06-14T08:00:00.000Z', '2026-06-14T08:05:00.000Z')).resolves.toBe(true);
  });
});
