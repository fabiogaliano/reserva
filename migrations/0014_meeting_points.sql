-- Records which of a tour's meeting points the customer picked. meeting_point_label is a
-- snapshot taken at write time (not a live join), so a booking still renders a usable location
-- even if the operator later removes that point from config. Both columns are additive and
-- nullable; pre-migration rows keep NULL and fall back to today's no-id behavior.
ALTER TABLE bookings ADD COLUMN meeting_point_id TEXT;
ALTER TABLE bookings ADD COLUMN meeting_point_label TEXT;
