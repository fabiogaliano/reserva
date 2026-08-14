// Plan 020 (design decision 7): the one refund executor both the operator HTTP path
// (src/handlers/index.ts's resolvePendingRefund) and the scheduled reconciler (src/reconciliation.ts,
// step 5) call — the Stripe-call-then-resolve core is identical either way, so a fix or a new
// safeguard here protects both callers at once.
//
// The two callers differ only in HOW they got permission to attempt: the HTTP path relies on the
// refund-operation's own decision claim (claimRefundOperation, already unique per booking_id) plus
// an immediate re-read guard against a same-choice loser; the scheduled path additionally holds a
// claimRefundExecution/claimRefundExecutionForRetry execution lease before ever calling this
// function, and passes that claim's attempt number in so a retryable failure gets a backoff
// next_attempt_at and a permanent/exhausted failure becomes 'abandoned' (mirroring
// src/confirmation.ts's classifyAttemptOutcome for side-effect operations). Passing no `attempt`
// preserves the exact pre-plan-020 HTTP behavior byte-for-byte, including the re-read guard —
// deliberately NOT gated behind a fresh execution claim there: BK-REFUND-001 finding #4's
// crash-recovery test (a Stripe success whose D1 write then throws) requires an immediate retry —
// even on the same clock tick — to re-enter and call Stripe again, which a claim (even a bypass
// one) with a staleness-gated lease cannot support at zero elapsed time. That is safe only because
// StripeProvider.refund()'s own idempotency key (not this D1 claim) is what actually prevents a
// double refund on a repeated Stripe call — the D1 claim exists to avoid redundant/observable
// double-attempts from the scheduled path, not to gate correctness.
import { classifyAttemptOutcome } from './confirmation';
import type { Booking } from './core/booking';
import type { BookkitContext } from './context';
import { nowIso } from './context';
import { computeNextAttemptAt } from './reconciliation-helpers';
import type { RefundChoice } from './repo';

export type RefundAttemptOutcome =
  // Stripe succeeded (or choice === 'none', which never touches Stripe) and the outcome is recorded.
  | { kind: 'succeeded' }
  // A same-choice loser's stale snapshot lost the re-read race to an already-resolved winner —
  // never attempted Stripe. HTTP-path-only (attempt undefined); the scheduled path never sees this
  // because its claim already excludes a 'succeeded' row.
  | { kind: 'skipped' }
  // 'full' was requested but the booking has no Stripe payment intent (a free booking, or legacy
  // data) — recorded as a permanent 'failed' row; retrying without a payment intent could never
  // succeed, so the scheduled path should treat this the same as an unrecoverable failure.
  | { kind: 'payment_intent_missing' }
  // Stripe's refund() call itself failed. `retryable`/`statusCode` are classifyProviderError's
  // verdict — the scheduled path already used these to decide 'failed' vs 'abandoned' before
  // calling resolveRefundOperation; the HTTP caller only needs to know to report a 502.
  | { kind: 'failed'; message: string; retryable: boolean; statusCode: number | undefined };

// Present only when the caller already holds an execution claim (claimRefundExecution /
// claimRefundExecutionForRetry) — i.e., the scheduled reconciler, never the HTTP path. attemptNumber
// is the 1-based count that claim call just returned.
export interface RefundExecutionClaim {
  attemptNumber: number;
}

export async function attemptRefund(
  context: BookkitContext,
  booking: Booking,
  operationId: string,
  choice: RefundChoice,
  paymentIntent: string | null,
  claim?: RefundExecutionClaim,
): Promise<RefundAttemptOutcome> {
  const { id: bookingId, priceCents } = booking;
  if (choice === 'none') {
    await context.repo.resolveRefundOperation(operationId, { status: 'succeeded', resolvedAt: nowIso(context) });
    return { kind: 'succeeded' };
  }
  if (!paymentIntent) {
    // Legacy requested rows can bypass the pre-claim guard below. They must remain visibly
    // unresolved rather than claiming a full refund succeeded when Stripe was never called.
    await context.repo.resolveRefundOperation(operationId, {
      status: 'failed', error: 'Stripe payment intent is missing', resolvedAt: nowIso(context),
    });
    return { kind: 'payment_intent_missing' };
  }
  if (!claim) {
    // A same-choice loser can hold a stale requested snapshot while the winner records success.
    // Re-read immediately before Stripe so it does not turn that success into a needless retry.
    const current = await context.repo.getRefundOperationByBookingId(bookingId);
    if (current?.id !== operationId || current.status === 'succeeded') return { kind: 'skipped' };
  }
  let result: { refundId: string; amountCents: number };
  try {
    result = await context.providers.payments.refund(paymentIntent, priceCents);
  } catch (error) {
    // Only a failure of the Stripe call itself is a genuine refund failure — record it so the
    // operation row remains for retry/reconciliation.
    if (claim) {
      const outcome = classifyAttemptOutcome(claim.attemptNumber, error);
      await context.repo.resolveRefundOperation(operationId, {
        status: outcome.status,
        error: outcome.error,
        resolvedAt: nowIso(context),
        nextAttemptAt: outcome.status === 'failed' ? computeNextAttemptAt(new Date(nowIso(context)), claim.attemptNumber) : null,
      });
      return { kind: 'failed', message: outcome.error, retryable: outcome.status === 'failed', statusCode: outcome.statusCode };
    }
    const message = error instanceof Error ? error.message : 'Refund failed';
    await context.repo.resolveRefundOperation(operationId, { status: 'failed', error: message, resolvedAt: nowIso(context) });
    return { kind: 'failed', message, retryable: true, statusCode: undefined };
  }
  // Stripe has already moved the money by this point — a failure recording that outcome to D1
  // must never be classified as a Stripe failure (that would misreport a completed refund as
  // failed, or mark it 'failed' forever). Let a write failure here propagate as a plain error
  // instead: the row stays 'requested'/'in_flight', and a retry recovers the same result via
  // Stripe's idempotency key (or, once that key's ~24h window has lapsed, via refunds.list
  // reconciliation in StripeProvider.refund) rather than ever double-refunding or losing the
  // outcome.
  await context.repo.resolveRefundOperation(operationId, {
    status: 'succeeded', stripeRefundId: result.refundId, amountCents: result.amountCents, resolvedAt: nowIso(context),
  });
  return { kind: 'succeeded' };
}
