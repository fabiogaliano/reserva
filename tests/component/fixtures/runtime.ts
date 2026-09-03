import type { D1Database } from '@cloudflare/workers-types';
import { defineReservaRuntime } from '../../../src/runtime';
import type { ReservaContextInput } from '../../../src/context';
import { fakeRepository, providers } from '../../fakes';
import { config } from '../../fixtures';

// Wired as the reserva integration's runtimeEntrypoint so `virtual:reserva/runtime` resolves for
// the route modules the component suite imports (createRouteContext resolves it at module load,
// so the import itself fails without this).
export const FIXED_NOW = '2026-06-14T08:00:00.000Z';

export default defineReservaRuntime({
  config,
  createContext: async ({ config: resolvedConfig }): Promise<ReservaContextInput> => ({
    config: resolvedConfig,
    db: {} as D1Database, // never touched: repo below is the in-memory fake
    repo: fakeRepository(),
    providers: providers(),
    clock: () => new Date(FIXED_NOW),
  }),
});
