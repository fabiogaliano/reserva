-- Plan 017 (design decision 3): a tour can now declare more than one free meeting point
-- (src/core/config.ts TourConfig.meetingPoints), so checkout must record which one the customer
-- picked. meeting_point_id is the resolved point's config id (checkout always stores an id
-- resolved via resolveMeetingPoint, src/core/config.ts -- never "absent"). No CHECK: the
-- id domain lives in config, which the DB can't see, same reasoning as tour_slug having no CHECK.
--
-- meeting_point_label is a label SNAPSHOT taken at write time, not a live join -- rendering
-- resolves label/mapsUrl live from config by id (matching today's live-resolution semantics for
-- pickupAddress etc.), but an operator can remove a declared point after bookings already
-- reference its id, and validateConfig cannot cross-check the DB to prevent that. When the id is
-- no longer declared, rendering falls back to this stored label (without a maps link) instead of
-- losing the customer's choice entirely.
--
-- Both columns are additive and nullable. Pre-migration rows have NULL in both and keep today's
-- behavior (resolveMeetingPoint's no-id fallback: the first/only declared point).
ALTER TABLE bookings ADD COLUMN meeting_point_id TEXT;
ALTER TABLE bookings ADD COLUMN meeting_point_label TEXT;
