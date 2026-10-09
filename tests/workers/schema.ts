import { RESERVA_SCHEMA_TABLES } from '../../src/generated/schema-fingerprint';

// Bookings outlive their dependent tables, and partners outlive bookings and current offers.
// Reading the remaining tables from the fingerprint keeps future migrations in the reset.
const RESERVA_TABLES = [...Object.keys(RESERVA_SCHEMA_TABLES).filter((table) => table !== 'bookings' && table !== 'partners'), 'bookings', 'partners'];

// Tears the schema and the migration ledger back to nothing, so a suite can rebuild exactly the
// state its scenario needs.
export async function dropReservaSchema(db: D1Database): Promise<void> {
  for (const table of RESERVA_TABLES) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await db.prepare('DROP TABLE IF EXISTS d1_migrations').run();
}
