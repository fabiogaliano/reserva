import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';

interface TestEnv {
  RESERVA_DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestEnv;
await applyD1Migrations(bindings.RESERVA_DB, bindings.TEST_MIGRATIONS);
