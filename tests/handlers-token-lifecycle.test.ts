import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it } from 'vitest';
import { createReservaContext } from '../src/context';
import { handleCustomerCancel, handleManage } from '../src/handlers';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

// BK-SEC-002: manage-token hashing, expiry, and revocation. These cover the security properties
// the old plaintext-column design didn't have — an expired or revoked token denied identically to
// an unknown one (no oracle), the stored representation not itself being a usable credential, and
// the compatibility fallback for rows written before this feature landed. Existing valid-token
// behavior (customer/operator role resolution, cutoffs, etc.) stays covered by
// tests/handlers-manage.test.ts and tests/handlers-customer-actions.test.ts; this file only adds
// the lifecycle behavior those didn't need to exercise.

const clock = () => new Date('2026-06-14T08:00:00.000Z');

function manageRequest(token?: string): Request {
  const url = new URL('https://example.test/api/booking/manage');
  if (token !== undefined) url.searchParams.set('token', token);
  return new Request(url);
}

function cancelRequest(token: string): Request {
  return new Request('https://example.test/api/booking/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

describe('manage-token expiry and revocation (BK-SEC-002)', () => {
  it('denies an expired cancel token with the same 403 as an unknown token', async () => {
    const seeded = booking({ id: 'b-token-expired', cancelToken: 'expiring-cancel-token' });
    const repo = fakeRepository([seeded]);
    // tokensExpireAt in the past relative to `clock` — mirrors a row insertHoldWithCapacity wrote
    // once booking.tokenExpiryDays has already elapsed.
    const state = repo.tokenState.get(seeded.id);
    if (!state) throw new Error('Seeded token state is missing');
    repo.tokenState.set(seeded.id, { ...state, tokensExpireAt: '2026-06-01T00:00:00.000Z' });
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleManage(manageRequest(seeded.cancelToken), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'forbidden' } });
  });

  it('denies an expired operator token identically', async () => {
    const seeded = booking({ id: 'b-token-expired-operator', operatorToken: 'expiring-operator-token' });
    const repo = fakeRepository([seeded]);
    const state = repo.tokenState.get(seeded.id);
    if (!state) throw new Error('Seeded token state is missing');
    repo.tokenState.set(seeded.id, { ...state, tokensExpireAt: '2026-06-01T00:00:00.000Z' });
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const response = await handleManage(manageRequest(seeded.operatorToken), context);
    expect(response.status).toBe(403);
  });

  it('cancelling a booking revokes its customer token but leaves the operator token usable', async () => {
    const seeded = booking({
      id: 'b-token-revoke',
      startsAt: '2026-06-15T09:00:00.000Z',
      endsAt: '2026-06-15T10:00:00.000Z',
      cancelToken: 'revoke-cancel-token',
      operatorToken: 'revoke-operator-token',
    });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    const cancelResponse = await handleCustomerCancel(cancelRequest(seeded.cancelToken), context);
    expect(cancelResponse.status).toBe(200);

    // Same token, presented again: denied exactly like an unknown token, not a stale-but-visible one.
    const reuse = await handleManage(manageRequest(seeded.cancelToken), context);
    expect(reuse.status).toBe(403);
    await expect(reuse.json()).resolves.toMatchObject({ error: { code: 'forbidden' } });

    // The operator token still resolves — the post-cancellation refund-reconciliation flow
    // (reconcileCancelledRefund, src/handlers/index.ts) depends on this remaining valid.
    const operatorView = await handleManage(manageRequest(seeded.operatorToken), context);
    expect(operatorView.status).toBe(200);
    const payload = await operatorView.json() as { role: string };
    expect(payload.role).toBe('operator');
  });

  it('authenticates a legacy plaintext-era row once via the compat fallback, then upgrades it — the stored hash is not the presented token and cannot itself be presented to authenticate', async () => {
    const seeded = booking({ id: 'b-token-legacy', cancelToken: 'legacy-plaintext-cancel-token' });
    const repo = fakeRepository([seeded]);
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });

    expect(repo.tokenState.get(seeded.id)?.cancelTokenHash).toBeNull();

    const first = await handleManage(manageRequest(seeded.cancelToken), context);
    expect(first.status).toBe(200);

    const state = repo.tokenState.get(seeded.id);
    expect(state?.cancelTokenHash).toBeTruthy();
    expect(state?.cancelTokenHash).not.toBe(seeded.cancelToken);

    // The stored hash is not itself a usable credential: presenting it as a token must not
    // resolve, either via the hash path (it won't hash to itself) or the plaintext fallback
    // (guarded by cancelTokenHash !== null — mirrors src/repo.ts's `cancel_token_hash IS NULL`
    // guard, which is what closes the "leaked hash presented as a token" oracle).
    const hashAsToken = await handleManage(manageRequest(state!.cancelTokenHash!), context);
    expect(hashAsToken.status).toBe(403);

    // The real token still works — now via the upgraded hash, not the plaintext fallback.
    const second = await handleManage(manageRequest(seeded.cancelToken), context);
    expect(second.status).toBe(200);
  });

  it('rejects an unknown token with the same 403 shape used for expired/revoked tokens', async () => {
    const repo = fakeRepository([booking({ id: 'b-token-baseline' })]);
    const context = createReservaContext({ config, db: {} as D1Database, repo, clock, providers: providers() });
    const response = await handleManage(manageRequest('never-issued-token'), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'forbidden' } });
  });
});
