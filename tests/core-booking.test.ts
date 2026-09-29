import { describe, expect, it } from 'vitest';
import {
  BookingTransitionError,
  cancelBooking,
  confirmBooking,
  markNoShow,
  rescheduleBooking,
  transitionBooking,
} from '../src/core/booking';
import { booking } from './fixtures';

describe('core booking state machine', () => {
  it('supports hold confirmation and expiration', () => {
    const hold = booking({ status: 'hold', holdExpiresAt: '2026-06-15T08:35:00.000Z' });
    expect(confirmBooking(hold, '2026-06-15T08:10:00.000Z').status).toBe('confirmed');
    const expired = transitionBooking(hold, 'expired', '2026-06-15T08:36:00.000Z');
    expect(expired.status).toBe('expired');
    expect(confirmBooking(expired, '2026-06-15T08:40:00.000Z').status).toBe('confirmed');
  });

  it('supports customer cancellation and records its actor', () => {
    const cancelled = cancelBooking(booking(), 'customer', '2026-06-14T11:00:00.000Z');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledBy).toBe('customer');
    expect(cancelled.cancelledAt).toBe('2026-06-14T11:00:00.000Z');
  });

  it('reschedules a confirmed booking without creating a second booking', () => {
    const result = rescheduleBooking(booking(), '2026-06-16T09:00:00.000Z', 90, '2026-06-14T00:00:00.000Z');
    expect(result.id).toBe('booking-1');
    expect(result.startsAt).toBe('2026-06-16T09:00:00.000Z');
    expect(result.endsAt).toBe('2026-06-16T10:30:00.000Z');
    expect(result.rescheduledFrom).toBe('2026-06-15T09:00:00.000Z');
  });

  it('only permits no-show after a confirmed booking starts', () => {
    expect(() => markNoShow(booking(), '2026-06-15T08:59:59.000Z')).toThrow(/after its start/);
    expect(markNoShow(booking(), '2026-06-15T09:00:00.001Z').status).toBe('no_show');
    expect(() => markNoShow(booking({ status: 'cancelled' }), '2026-06-15T12:00:00.000Z')).toThrow(BookingTransitionError);
  });

  it('makes terminal same-state transitions immutable and requires cancellation actor metadata', () => {
    const cancelled = booking({ status: 'cancelled', cancelledBy: 'customer' });
    expect(transitionBooking(cancelled, 'cancelled', '2026-06-15T12:00:00.000Z')).toBe(cancelled);
    expect(() => transitionBooking(booking(), 'cancelled', '2026-06-15T08:00:00.000Z')).toThrow(/cancelledBy/);
  });

  it('rejects impossible state transitions', () => {
    expect(() => transitionBooking(booking(), 'expired', '2026-06-15T08:00:00.000Z')).toThrow(BookingTransitionError);
  });
});
