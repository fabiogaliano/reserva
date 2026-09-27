import type { D1Database } from '@cloudflare/workers-types';
import { defineReservaRuntime } from '../../../src/runtime';
import type { ReservaContextInput } from '../../../src/context';
import { fakeRepository, providers } from '../../fakes';

// Wired as the reserva integration's runtimeEntrypoint so `virtual:reserva/runtime` resolves for
// the route modules the component suite imports (createRouteContext resolves it at module load,
// so the import itself fails without this).
export const FIXED_NOW = '2026-06-14T08:00:00.000Z';

// Swapped per test by the route suites that need seeded bookings to persist across the requests
// one flow makes (a POST, then the GET it redirects to), or a clock on a DST edge; every other
// suite gets an empty repo at FIXED_NOW.
export const componentState: { repo: ReturnType<typeof fakeRepository>; now: string } = { repo: fakeRepository(), now: FIXED_NOW };

// No `config` option: the runtime reads it from `virtual:reserva/config`, which the component
// project's real integration build emits from the same `tests/fixtures.ts` config.
export default defineReservaRuntime({
  createContext: async ({ config: resolvedConfig }): Promise<ReservaContextInput> => ({
    config: resolvedConfig,
    db: {} as D1Database, // never touched: repo below is the in-memory fake
    repo: componentState.repo,
    providers: providers(),
    clock: () => new Date(componentState.now),
  }),
});
