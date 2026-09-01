import type { Booking } from './booking';

export interface VerifiedPaymentFacts {
  completed: boolean;
  sessionRef?: string | undefined;
  paid?: boolean | undefined;
  paymentStatus?: string | undefined;
  amountTotal?: number | undefined;
  currency?: string | undefined;
  expectedCurrency: string;
}

export type PaymentVerification =
  | { allowed: true; sessionRefToBackfill?: string }
  | {
    allowed: false;
    reason:
      | 'session_not_complete'
      | 'session_ref_missing'
      | 'session_mismatch'
      | 'payment_not_paid'
      | 'amount_missing'
      | 'amount_mismatch'
      | 'currency_mismatch'
      | 'payment_not_required';
  };

export function verifyPayment(booking: Booking, facts: VerifiedPaymentFacts): PaymentVerification {
  if (!facts.completed) return { allowed: false, reason: 'session_not_complete' };
  if (!facts.sessionRef) return { allowed: false, reason: 'session_ref_missing' };
  if (booking.paymentSessionRef && booking.paymentSessionRef !== facts.sessionRef) {
    return { allowed: false, reason: 'session_mismatch' };
  }
  if (booking.priceMinor === 0) {
    if (facts.paid === true || facts.paymentStatus === 'no_payment_required') {
      return booking.paymentSessionRef ? { allowed: true } : { allowed: true, sessionRefToBackfill: facts.sessionRef };
    }
    return { allowed: false, reason: 'payment_not_required' };
  }
  if (facts.paid !== true) return { allowed: false, reason: 'payment_not_paid' };
  if (facts.amountTotal === undefined) return { allowed: false, reason: 'amount_missing' };
  if (facts.amountTotal !== booking.priceMinor) return { allowed: false, reason: 'amount_mismatch' };
  if (facts.currency !== facts.expectedCurrency) return { allowed: false, reason: 'currency_mismatch' };
  return booking.paymentSessionRef ? { allowed: true } : { allowed: true, sessionRefToBackfill: facts.sessionRef };
}
