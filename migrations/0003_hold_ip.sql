ALTER TABLE bookings ADD COLUMN hold_ip TEXT;

CREATE INDEX idx_bookings_hold_ip ON bookings (hold_ip, status, hold_expires_at);
