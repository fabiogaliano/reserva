// The positive astro-dev bypass for Cloudflare Access is proven in workers/smoke-runtime; this file
// owns the other half of the rule, that a custom adminAuth still decides in dev.
import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { accessAllowed } from '../src/admin-access';
import { createReservaContext } from '../src/context';
import { resolvedRoutePaths } from '../src/routes-manifest';
import { config } from './fixtures';
import { fakeRepository, providers } from './fakes';

describe('accessAllowed dev bypass', () => {
  it('never bypasses a custom adminAuth under astro dev: a null from it stays unauthorized', async () => {
    const { access: _omit, ...adminWithoutAccess } = config.admin;
    const context = createReservaContext({
      config: { ...config, admin: adminWithoutAccess },
      db: {} as D1Database,
      repo: fakeRepository(),
      providers: providers(),
      routeConfig: { paths: resolvedRoutePaths(), groups: { admin: true, ops: true, manage: true }, dev: true },
      adminAuth: async () => null,
    });
    await expect(accessAllowed(new Request('https://example.test/booking/admin'), context)).resolves.toBeNull();
  });
});
