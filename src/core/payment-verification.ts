import type { Booking } from './booking';

export interface VerifiedPaymentFacts {
  completed: boolean;
  sessionId?: string | undefined;
  paid?: boolean | undefined;
  paymentStatus?: string | undefined;
  amountTotal?: number | undefined;
  currency?: string | undefined;
  expectedCurrency: string;
}

export type PaymentVerification =
  | { allowed: true; sessionIdToBackfill?: string }
  | {
    allowed: false;
    reason:
      | 'session_not_complete'
      | 'session_id_missing'
      | 'session_mismatch'
      | 'payment_not_paid'
      | 'amount_missing'
      | 'amount_mismatch'
      | 'currency_mismatch'
      | 'payment_not_required';
  };

export function verifyPayment(booking: Booking, facts: VerifiedPaymentFacts): PaymentVerification {
  if (!facts.completed) return { allowed: false, reason: 'session_not_complete' };
  if (!facts.sessionId) return { allowed: false, reason: 'session_id_missing' };
  if (booking.stripeSessionId && booking.stripeSessionId !== facts.sessionId) {
    return { allowed: false, reason: 'session_mismatch' };
  }
  if (booking.priceCents === 0) {
    if (facts.paid === true || facts.paymentStatus === 'no_payment_required') {
      return booking.stripeSessionId ? { allowed: true } : { allowed: true, sessionIdToBackfill: facts.sessionId };
    }
    return { allowed: false, reason: 'payment_not_required' };
  }
  if (facts.paid !== true) return { allowed: false, reason: 'payment_not_paid' };
  if (facts.amountTotal === undefined) return { allowed: false, reason: 'amount_missing' };
  if (facts.amountTotal !== booking.priceCents) return { allowed: false, reason: 'amount_mismatch' };
  if (facts.currency !== facts.expectedCurrency) return { allowed: false, reason: 'currency_mismatch' };
  return booking.stripeSessionId ? { allowed: true } : { allowed: true, sessionIdToBackfill: facts.sessionId };
}
