// Reserva's own D1 migration filenames, in apply order, mirroring migrations/*.sql exactly.
// Kept as a plain list rather than read from disk: the isolate-time schema check in
// runtime-context.ts runs inside a Cloudflare Worker, which has no filesystem. This list is
// guarded against drifting from the migrations/ directory by tests/migrations-manifest.test.ts.
export const RESERVA_MIGRATIONS = [
  '0001_init.sql',
] as const;
