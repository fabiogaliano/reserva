-- What happened to a booking's money after payment, kept on the booking itself so a reader (the
-- admin, a payout check) never reconstructs it from refund rows or outbox rows.
--
-- amount_refunded_minor is the provider's running total of refunds sent on the payment, partial or
-- full, whoever issued them. The provider reports that total without a refund id, so writers keep
-- the larger of the stored and reported values and an out-of-order delivery cannot lower it.
ALTER TABLE bookings ADD COLUMN amount_refunded_minor INTEGER NOT NULL DEFAULT 0 CHECK (amount_refunded_minor >= 0);
-- The first time a dispute was seen; never moved by a later event.
ALTER TABLE bookings ADD COLUMN disputed_at TEXT;
-- NULL means never disputed. 'won' covers an inquiry that closed without a chargeback.
ALTER TABLE bookings ADD COLUMN dispute_status TEXT CHECK (dispute_status IN ('open','won','lost'));

-- refund_operations holds at most one row per booking, and a succeeded one records what the
-- provider reported it moved.
UPDATE bookings
SET amount_refunded_minor = (
  SELECT amount_cents FROM refund_operations
  WHERE refund_operations.booking_id = bookings.id AND refund_operations.status = 'succeeded'
)
WHERE id IN (
  SELECT booking_id FROM refund_operations WHERE status = 'succeeded' AND amount_cents > 0
);

-- Earlier releases recorded a dispute only as its outbox rows and never learned the outcome, so
-- every dispute found there is carried over as still open.
UPDATE bookings
SET disputed_at = (
  SELECT MIN(created_at) FROM side_effect_operations
  WHERE side_effect_operations.booking_id = bookings.id AND side_effect_operations.event = 'payment.dispute_created'
),
dispute_status = 'open'
WHERE id IN (
  SELECT booking_id FROM side_effect_operations WHERE event = 'payment.dispute_created'
);
