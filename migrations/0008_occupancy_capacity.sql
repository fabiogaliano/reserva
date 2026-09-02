-- Adds occupancy_units / occupancy_ends_at so capacity allocation can be checked in pure SQL
-- (see src/core/occupancy.ts). Both are nullable: backfilling existing rows needs the JS tour
-- config, which isn't available to SQL, so pre-migration rows stay NULL and are treated as a
-- single default-turnaround unit by the capacity guard (COALESCE fallback in src/repo.ts).
ALTER TABLE bookings ADD COLUMN occupancy_units INTEGER;
ALTER TABLE bookings ADD COLUMN occupancy_ends_at TEXT;
