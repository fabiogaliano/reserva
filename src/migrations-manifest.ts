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
] as const;
