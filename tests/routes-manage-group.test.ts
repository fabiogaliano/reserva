// Plan 027 (design decision 8, step 7): `config.routes.manage` switches off Reserva's
// server-rendered /booking/manage page and NOTHING else. The property under test is a negative one
// — with the page gone, no library-owned surface may still link to it — so each of the three link
// producers (email, admin dashboard, the manage entry component) is exercised for real here rather
// than asserted on the flag alone.
import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { createBookkitContext } from '../src/context';
import { handleAdminGet } from '../src/handlers';
import { bookkit } from '../src/integration';
import { brevoEmail } from '../src/providers/brevo';
import { requireEnabledRoutePath, resolveRouteConfig } from '../src/routes-manifest';
import clientConfig from '../examples/client-config';
import { booking, config } from './fixtures';
import { fakeRepository, providers } from './fakes';

function injectedPatterns(routes: Record<string, unknown>): string[] {
  const injected: Array<Record<string, unknown>> = [];
  const integration = bookkit({ config: { ...clientConfig, routes }, runtimeEntrypoint: './examples/runtime.ts' } as never);
  const hook = integration.hooks['astro:config:setup'];
  if (!hook) throw new Error('setup hook is missing');
  hook({
    config: { root: new URL('../', import.meta.url) } as never,
    command: 'build',
    isRestart: false,
    injectRoute: (route: any) => injected.push(route),
    updateConfig: () => ({} as never),
    logger: { info() {}, warn() {}, error() {} },
  } as never);
  return injected.map((route) => String(route.pattern));
}

async function adminHtml(manage: boolean): Promise<string> {
  const seeded = booking({ id: 'b-manage-flag', operatorToken: 'op-manage-token', cancelToken: 'cancel-manage-token' });
  const context = createBookkitContext({
    config,
    db: {} as D1Database,
    repo: fakeRepository([seeded], { tokenEncryptionKey: 'manage-flag-key' }),
    clock: () => new Date('2026-06-14T08:00:00.000Z'),
    adminAuth: async () => ({ subject: '' }),
    providers: providers(),
    secrets: async (name) => (name === 'BOOKKIT_TOKEN_ENC_KEY' ? 'manage-flag-key' : undefined),
    routeConfig: resolveRouteConfig('', { admin: true, ops: true, manage }),
  });
  const response = await handleAdminGet(new Request('https://example.test/booking/admin'), context);
  return response.text();
}

async function emailBodies(manage: boolean): Promise<string> {
  const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
  await brevoEmail({ apiKey: 'key', fetchImpl: request }).send(
    'booking.confirmed',
    booking(),
    config,
    resolveRouteConfig('', { admin: true, ops: true, manage }),
  );
  expect(request.mock.calls.length).toBeGreaterThan(0);
  return request.mock.calls.map((call) => String(call[1]?.body)).join('\n');
}

describe('config.routes.manage (plan 027 design decision 8)', () => {
  it('omits only the built-in page, keeping every manage/cancel/reschedule API mounted', () => {
    const patterns = injectedPatterns({ manage: false });
    expect(patterns).not.toContain('/booking/manage');
    // The whole point of the flag: a headless consumer drops the page and builds its own UI on the
    // same customer endpoints, which stay in the always-mounted `customer` group.
    for (const kept of ['/api/booking/manage', '/api/booking/cancel', '/api/booking/reschedule', '/api/booking/status']) {
      expect(patterns).toContain(kept);
    }
    expect(patterns).toHaveLength(injectedPatterns({}).length - 1);
  });

  it('defaults to on, so a consumer that never mentions routes sees the page and its links as before', async () => {
    expect(injectedPatterns({})).toContain('/booking/manage');
    expect(await emailBodies(true)).toContain('/booking/manage?token=');
    expect(await adminHtml(true)).toContain('/booking/manage?token=');
  });

  it('emails drop the manage links instead of shipping a 404 to a customer inbox', async () => {
    const bodies = await emailBodies(false);
    expect(bodies).not.toContain('/booking/manage');
    // Still a real, complete email — only the button is gone.
    expect(bodies).toContain('ada@example.test');
  });

  it('the admin dashboard renders its unavailable state instead of a dead manage link', async () => {
    const html = await adminHtml(false);
    expect(html).not.toContain('/booking/manage');
    // The row itself is unaffected — the booking is still listed, just without the link.
    expect(html).toContain('LVT-2026-001');
  });

  it('the manage entry component refuses to default to a route that is not mounted, naming the flag', () => {
    // What <ManageBooking /> evaluates for its form action when no explicit endpoint is passed.
    const disabled = resolveRouteConfig('', { admin: true, ops: true, manage: false });
    expect(() => requireEnabledRoutePath(disabled, 'managePage'))
      .toThrow(/routes: \{ manage: false \}.*Enable routes\.manage or provide an explicit endpoint/);
    expect(requireEnabledRoutePath(resolveRouteConfig(''), 'managePage')).toBe('/booking/manage');
  });
});
