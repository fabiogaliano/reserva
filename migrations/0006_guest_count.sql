-- The exact headcount the payer typed at checkout, for services that opt in with
-- `collectGuestCount`. `quantity` stays the priced size (for an "up to N" vehicle it is the tier,
-- not the people in it); NULL means the service does not ask or the payer left it blank.
ALTER TABLE bookings ADD COLUMN guest_count INTEGER CHECK (guest_count IS NULL OR guest_count > 0);
