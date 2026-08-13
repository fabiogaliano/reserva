import type { D1Database } from '@cloudflare/workers-types';
import { defineBookkitRuntime } from '../../../src/runtime';
import type { BookkitContextInput } from '../../../src/context';
import { fakeRepository, providers } from '../../fakes';
import { config } from '../../fixtures';

// Plan 009 component-render test fixture (tests/component/admin-dashboard.test.ts). Wired into a
// single Vite/Astro config (vitest.component.config.ts) as the bookkit integration's
// runtimeEntrypoint, so `virtual:bookkit/runtime` resolves for AdminDashboard.astro's frontmatter
// exactly as it would in a real consumer build. One fixture backs every test case: the request
// itself selects the Access/secret scenario via test-only headers, since re-configuring Vite per
// scenario isn't practical inside a single container-rendered test file.
export const ACCESS_HEADER = 'x-test-access'; // 'allow' | 'claims' | 'deny' | 'throw'; absent => no verifyAccess wired at all
export const SECRET_HEADER = 'x-test-csrf-secret';
export const FIXED_NOW = '2026-06-14T08:00:00.000Z';

export default defineBookkitRuntime({
  config,
  createContext: async ({ request, config: resolvedConfig }): Promise<BookkitContextInput> => {
    const accessMode = request.headers.get(ACCESS_HEADER);
    const secret = request.headers.get(SECRET_HEADER);
    return {
      config: resolvedConfig,
      db: {} as D1Database, // never touched: repo below is the in-memory fake
      repo: fakeRepository(),
      providers: providers(),
      clock: () => new Date(FIXED_NOW),
      secrets: async (name) => (name === 'BOOKKIT_CSRF_SECRET' ? secret ?? undefined : undefined),
      ...(accessMode === null ? {} : {
        verifyAccess: async () => {
          if (accessMode === 'deny') return false;
          if (accessMode === 'throw') throw new Error('verifyAccess exploded (test fixture)');
          // Real claims (not a plain boolean) to exercise the per-subject binding path, mirroring
          // the default Cloudflare Access wiring (src/runtime-context.ts verifyAccessJwt).
          if (accessMode === 'claims') return { iss: 'https://test.cloudflareaccess.com', aud: 'test-aud', sub: 'ops@example.test', email: 'ops@example.test' };
          return true; // 'allow'
        },
      }),
    };
  },
});
