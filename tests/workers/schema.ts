import { RESERVA_SCHEMA_TABLES } from '../../src/generated/schema-fingerprint';

// Every table reserva's migrations create, read from the generated fingerprint so a new table is
// never missed. `bookings` goes last: the other tables hold foreign keys into it.
const RESERVA_TABLES = [...Object.keys(RESERVA_SCHEMA_TABLES).filter((table) => table !== 'bookings'), 'bookings'];

// Tears the schema and the migration ledger back to nothing, so a suite can rebuild exactly the
// state its scenario needs.
export async function dropReservaSchema(db: D1Database): Promise<void> {
  for (const table of RESERVA_TABLES) await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  await db.prepare('DROP TABLE IF EXISTS d1_migrations').run();
}
