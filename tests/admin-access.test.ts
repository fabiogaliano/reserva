// Focused unit coverage for accessAllowed's subject normalization (extracted from
// src/handlers/index.ts into src/admin-access.ts by plan 009, so AdminDashboard.astro can share it
// without duplicating this logic). handlers-admin.test.ts already covers the
// absent/false/throws -> null cases end to end through handleAdminGet/handleAdminPost; this file
// adds the claims -> subject derivation branch neither of those exercise (every existing fixture's
// verifyAccess only ever returns a plain boolean).
import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { accessAllowed } from '../src/admin-access';
import { createBookkitContext } from '../src/context';
import { config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const REQUEST = new Request('https://example.test/booking/admin');

function contextWith(verifyAccess: NonNullable<Parameters<typeof createBookkitContext>[0]['verifyAccess']>) {
  return createBookkitContext({
    config,
    db: {} as D1Database,
    repo: fakeRepository(),
    providers: providers(),
    verifyAccess,
  });
}

describe('accessAllowed (src/admin-access.ts)', () => {
  it('returns null when verifyAccess is absent', async () => {
    const context = createBookkitContext({ config, db: {} as D1Database, repo: fakeRepository(), providers: providers() });
    await expect(accessAllowed(REQUEST, context)).resolves.toBeNull();
  });

  it('returns null when verifyAccess returns false', async () => {
    const context = contextWith(() => false);
    await expect(accessAllowed(REQUEST, context)).resolves.toBeNull();
  });

  it('returns null when verifyAccess throws', async () => {
    const context = contextWith(() => { throw new Error('access check exploded'); });
    await expect(accessAllowed(REQUEST, context)).resolves.toBeNull();
  });

  it('returns the empty subject when verifyAccess returns a plain boolean true (no claims to bind to)', async () => {
    const context = contextWith(() => true);
    await expect(accessAllowed(REQUEST, context)).resolves.toEqual({ sub: '' });
  });

  it('prefers claims.email over claims.sub as the bound subject', async () => {
    const context = contextWith(() => ({ iss: 'https://team.cloudflareaccess.com', aud: 'aud', sub: 'raw-sub-claim', email: 'ops@example.test' }));
    await expect(accessAllowed(REQUEST, context)).resolves.toEqual({ sub: 'ops@example.test' });
  });

  it('falls back to claims.sub when email is absent', async () => {
    const context = contextWith(() => ({ iss: 'https://team.cloudflareaccess.com', aud: 'aud', sub: 'raw-sub-claim' }));
    await expect(accessAllowed(REQUEST, context)).resolves.toEqual({ sub: 'raw-sub-claim' });
  });

  it('falls back to the empty subject when claims carry neither email nor a string sub', async () => {
    const context = contextWith(() => ({ iss: 'https://team.cloudflareaccess.com', aud: 'aud', sub: 42 as unknown as string }));
    await expect(accessAllowed(REQUEST, context)).resolves.toEqual({ sub: '' });
  });
});
