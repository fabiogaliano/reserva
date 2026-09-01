// Focused unit coverage for accessAllowed's fail-closed gate (extracted from src/handlers/index.ts
// into src/admin-access.ts by plan 009, promoted from a Cloudflare-Access-specific boolean/claims
// hook to the generic `adminAuth` port by plan 025, so AdminDashboard.astro can share it without
// duplicating this logic). handlers-admin.test.ts already covers the absent/null/throws -> null
// cases end to end through handleAdminGet/handleAdminPost; this file adds the identity-passthrough
// behavior neither of those exercise directly.
import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { accessAllowed } from '../src/admin-access';
import { createBookkitContext } from '../src/context';
import { config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const REQUEST = new Request('https://example.test/booking/admin');

function contextWith(adminAuth: NonNullable<Parameters<typeof createBookkitContext>[0]['adminAuth']>) {
  return createBookkitContext({
    config,
    db: {} as D1Database,
    repo: fakeRepository(),
    providers: providers(),
    adminAuth,
  });
}

describe('accessAllowed (src/admin-access.ts)', () => {
  it('returns null when adminAuth is absent', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), providers: providers() });
    await expect(accessAllowed(REQUEST, context)).resolves.toBeNull();
  });

  it('returns null when adminAuth resolves to null', async () => {
    const context = contextWith(async () => null);
    await expect(accessAllowed(REQUEST, context)).resolves.toBeNull();
  });

  it('returns null when adminAuth throws (fail-closed, not a 500)', async () => {
    const context = contextWith(() => { throw new Error('adminAuth exploded'); });
    await expect(accessAllowed(REQUEST, context)).resolves.toBeNull();
  });

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
