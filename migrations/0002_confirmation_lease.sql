ALTER TABLE bookings ADD COLUMN confirmation_lease_token TEXT;
ALTER TABLE bookings ADD COLUMN confirmation_lease_until TEXT;

CREATE INDEX idx_bookings_confirmation_lease ON bookings (confirmation_lease_until);
