// Bookkit's own D1 migration filenames, in apply order, mirroring migrations/*.sql exactly.
// Kept as a plain list rather than read from disk: the isolate-time schema check in
// runtime-context.ts runs inside a Cloudflare Worker, which has no filesystem. This list is
// guarded against drifting from the migrations/ directory by tests/migrations-manifest.test.ts.
export const BOOKKIT_MIGRATIONS = [
  '0001_init.sql',
  '0002_confirmation_lease.sql',
  '0003_hold_ip.sql',
  '0004_capacity_defaults.sql',
  '0005_settings.sql',
  '0006_refund_operations.sql',
  '0007_side_effect_outbox.sql',
  '0008_occupancy_capacity.sql',
  '0009_token_hashing.sql',
  '0010_mutation_side_effect_outbox.sql',
  '0011_schema_constraints.sql',
  '0012_calendar_delete_outbox.sql',
  '0013_side_effect_operations_abandoned.sql',
  '0014_meeting_points.sql',
  '0015_pickup_options.sql',
  '0016_operational_reconciliation.sql',
  '0017_side_effect_operation_identity.sql',
  '0018_v2_domain_rename.sql',
] as const;
