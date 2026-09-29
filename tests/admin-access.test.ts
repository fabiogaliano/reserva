// The fail-closed cases (adminAuth absent, resolving null, or throwing) are proven end to end by
// handlers-admin.test.ts's access-control test; this file covers what adminAuth receives and returns.
import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { accessAllowed } from '../src/admin-access';
import { createReservaContext } from '../src/context';
import { config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const REQUEST = new Request('https://example.test/booking/admin');

function contextWith(adminAuth: NonNullable<Parameters<typeof createReservaContext>[0]['adminAuth']>) {
  return createReservaContext({
    config,
    db: {} as D1Database,
    repo: fakeRepository(),
    providers: providers(),
    adminAuth,
  });
}

describe('accessAllowed (src/admin-access.ts)', () => {
  it('passes through the resolved AdminIdentity unchanged', async () => {
    const context = contextWith(async () => ({ subject: 'ops@example.test', email: 'ops@example.test' }));
    await expect(accessAllowed(REQUEST, context)).resolves.toEqual({ subject: 'ops@example.test', email: 'ops@example.test' });
  });

  it('passes through the documented empty-subject identity for an anonymous custom implementation', async () => {
    const context = contextWith(async () => ({ subject: '' }));
    await expect(accessAllowed(REQUEST, context)).resolves.toEqual({ subject: '' });
  });

  it('invokes adminAuth with both the request and the context itself, so a custom implementation can read context.secrets/config', async () => {
    let seenRequest: Request | undefined;
    let seenContext: unknown;
    const context = contextWith(async (request, ctx) => {
      seenRequest = request;
      seenContext = ctx;
      return { subject: 'ops@example.test' };
    });
    await accessAllowed(REQUEST, context);
    expect(seenRequest).toBe(REQUEST);
    expect(seenContext).toBe(context);
  });
});
