import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { bookkit, virtualConfigId } from '../src/integration';
import { createBookkitContext } from '../src/context';
import { handleAdminGet } from '../src/handlers';
import { renderManagePage } from '../src/components/manage-page';
import {
  normalizeRoutePrefix,
  requireEnabledRoutePath,
  resolveRouteConfig,
  routeManifest,
  validateRouteOptions,
} from '../src/routes-manifest';
import config from '../examples/client-config';
import { booking } from './fixtures';
import { fakeRepository, providers } from './fakes';

// Mirrors tests/integration-entry.test.ts's harness: invoke the astro:config:setup hook directly
// (no real Astro build needed to observe injectRoute calls / the registered vite plugins).
function setup(options: Record<string, unknown>) {
  const routes: Array<Record<string, unknown>> = [];
  let viteConfig: Record<string, unknown> = {};
  const integration = bookkit(options as never);
  const hook = integration.hooks['astro:config:setup'];
  if (!hook) throw new Error('setup hook is missing');
  hook({
    config: { root: new URL('../', import.meta.url) } as never,
    command: 'build',
    isRestart: false,
    injectRoute: (route: any) => routes.push(route),
    updateConfig: (next: any) => {
      viteConfig = { ...viteConfig, ...(next as Record<string, unknown>) };
      return {} as never;
    },
    logger: { info() {}, warn() {}, error() {} },
  } as never);
  return { routes, viteConfig };
}

const baseOptions = { config, runtimeEntrypoint: './examples/runtime.ts' };

describe('normalizeRoutePrefix', () => {
  it.each([
    ['', ''],
    ['/', ''],
    ['en', '/en'],
    ['/en', '/en'],
    ['/en/', '/en'],
    ['en/', '/en'],
    ['/en///', '/en'],
    ['/pt-br', '/pt-br'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeRoutePrefix(input)).toBe(expected);
  });
});

describe('validateRouteOptions (Zod, same throw-on-safeParse-failure style as validateConfig)', () => {
  it('accepts no options', () => {
    expect(validateRouteOptions({})).toEqual({});
  });

  it('accepts a valid prefix', () => {
    expect(validateRouteOptions({ routePrefix: '/en' })).toEqual({ routePrefix: '/en' });
  });

  it('rejects a prefix containing whitespace', () => {
    expect(() => validateRouteOptions({ routePrefix: '/en service' })).toThrow(/whitespace/);
  });

  it('rejects a prefix containing ".." traversal segments', () => {
    expect(() => validateRouteOptions({ routePrefix: '/../etc' })).toThrow(/\.\./);
  });

  it.each(['//other-host', '/en?x=1', '/en#f', 'https://evil.example', '/a\\b', '/en//fr'])(
    'rejects URL or network-path syntax in %j',
    (routePrefix) => {
      expect(() => setup({ ...baseOptions, routePrefix })).toThrow();
    },
  );

  it.each([
    ['/en', '/en'],
    ['en', '/en'],
    ['/en/', '/en'],
    ['/en/fr', '/en/fr'],
  ])('accepts and normalizes safe prefix %j', (routePrefix, normalized) => {
    expect(validateRouteOptions({ routePrefix })).toEqual({ routePrefix });
    expect(normalizeRoutePrefix(routePrefix)).toBe(normalized);
  });
});

describe('requireEnabledRoutePath', () => {
  it('returns enabled route paths and rejects disabled groups with an actionable error', () => {
    const enabled = resolveRouteConfig('/en');
    expect(requireEnabledRoutePath(enabled, 'adminPage')).toBe('/en/booking/admin');
    expect(requireEnabledRoutePath(enabled, 'managePage')).toBe('/en/booking/manage');

    const withoutAdmin = resolveRouteConfig('/en', { admin: false, ops: true, manage: true });
    expect(() => requireEnabledRoutePath(withoutAdmin, 'adminPage'))
      .toThrow(/routes: \{ admin: false \}.*explicit endpoint/);
    expect(requireEnabledRoutePath(withoutAdmin, 'managePage')).toBe('/en/booking/manage');
  });
});

describe('route table generation (astro:config:setup)', () => {
  // Hard requirement: a consumer passing no new options must see the exact same route table as
  // before this feature existed — same patterns, same order.
  it('no options: default injected route patterns are byte-identical to the current 18', () => {
    const { routes } = setup(baseOptions);
    expect(routes.map((route) => route.pattern)).toEqual(routeManifest.map((entry) => entry.pattern));
    expect(routes).toHaveLength(18);
  });

  it('routePrefix mounts every route under the prefix, in the same order', () => {
    const { routes } = setup({ ...baseOptions, routePrefix: '/en' });
    expect(routes).toHaveLength(18);
    expect(routes.map((route) => route.pattern)).toEqual(routeManifest.map((entry) => `/en${entry.pattern}`));
  });

  it('an unnormalized prefix (no leading slash, trailing slash) still mounts correctly', () => {
    const { routes } = setup({ ...baseOptions, routePrefix: 'en/' });
    expect(routes.map((route) => route.pattern)).toEqual(routeManifest.map((entry) => `/en${entry.pattern}`));
  });

  // Plan 025 (design decision 3): routes.admin/routes.ops now live on `config.routes`, not on
  // BookkitIntegrationOptions — the integration reads the same validated config the runtime factory
  // reads for admin-auth selection, instead of two independently-settable options.
  it('config.routes: { ops: false } omits every operator route and nothing else', () => {
    const { routes } = setup({ ...baseOptions, config: { ...config, routes: { ops: false } } });
    const patterns = routes.map((route) => route.pattern);
    expect(patterns).toHaveLength(14);
    for (const opsPattern of ['/api/booking/operator/cancel', '/api/booking/operator/reschedule', '/api/booking/operator/no-show']) {
      expect(patterns).not.toContain(opsPattern);
    }
    // Customer + webhook + admin routes are unaffected.
    expect(patterns).toContain('/booking/admin');
    expect(patterns).toContain('/api/booking/checkout');
  });

  it('config.routes: { admin: false } omits only the admin dashboard route', () => {
    const { routes } = setup({ ...baseOptions, config: { ...config, routes: { admin: false } } });
    const patterns = routes.map((route) => route.pattern);
    expect(patterns).toHaveLength(17);
    expect(patterns).not.toContain('/booking/admin');
  });

  it('rejects an invalid routePrefix at setup time, before any route is injected', () => {
    expect(() => setup({ ...baseOptions, routePrefix: '/en service' })).toThrow(/whitespace/);
  });

  it('exposes the resolved (prefixed) paths and group flags through virtual:bookkit/config', () => {
    const { viteConfig } = setup({ ...baseOptions, routePrefix: '/en', config: { ...config, routes: { ops: false } } });
    const plugins = (viteConfig.vite as { plugins: Array<{ resolveId(id: string): string | undefined; load(id: string): string | undefined }> }).plugins;
    const plugin = plugins.find((candidate) => candidate.resolveId(virtualConfigId) !== undefined);
    if (!plugin) throw new Error('route-config plugin not registered');
    const resolved = plugin.resolveId(virtualConfigId) as string;
    const source = plugin.load(resolved) as string;
    const loaded = JSON.parse(source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1));
    expect(loaded).toEqual(resolveRouteConfig('/en', { admin: true, ops: false, manage: true }));
    expect(loaded.paths.checkout).toBe('/en/api/booking/checkout');
  });
});

describe('server-rendered HTML URL consistency', () => {
  it('renderManagePage uses the resolved (prefixed) manage path everywhere, never the unprefixed default', () => {
    const payload = { booking: { reference: 'LVT-2026-999' }, canCancel: true, canReschedule: true, canNoShow: true, token: 'tok-1' };
    const html = renderManagePage(payload, '/en/booking/manage');
    expect(html).toContain('action="/en/booking/manage"');
    expect(html).not.toMatch(/action="\/booking\/manage"/);
  });

  it('admin page manage links use the resolved (prefixed) manage path, never the unprefixed default', async () => {
    const clock = () => new Date('2026-06-14T08:00:00.000Z');
    const seeded = booking({ id: 'b-route-admin', operatorToken: 'op-route-token', cancelToken: 'cancel-route-token' });
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository([seeded], { tokenEncryptionKey: 'route-token-key' }),
      clock,
      adminAuth: async () => ({ subject: '' }),
      providers: providers(),
      secrets: async (name) => (name === 'BOOKKIT_TOKEN_ENC_KEY' ? 'route-token-key' : undefined),
      routeConfig: resolveRouteConfig('/en', { admin: true, ops: true, manage: true }),
    });

    const response = await handleAdminGet(new Request('https://example.test/en/booking/admin'), context);
    const body = await response.text();
    expect(body).toContain(`/en/booking/manage?token=${encodeURIComponent(seeded.operatorToken)}`);
    expect(body).not.toContain('href="/booking/manage');
  });

  it('a context built without an explicit routeConfig defaults to the unprefixed, all-groups-enabled table (no behavior change)', async () => {
    const clock = () => new Date('2026-06-14T08:00:00.000Z');
    const seeded = booking({ id: 'b-route-default', operatorToken: 'op-default-token', cancelToken: 'cancel-default-token' });
    const context = createBookkitContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository([seeded], { tokenEncryptionKey: 'route-token-key' }),
      clock,
      adminAuth: async () => ({ subject: '' }),
      providers: providers(),
      secrets: async (name) => (name === 'BOOKKIT_TOKEN_ENC_KEY' ? 'route-token-key' : undefined),
    });

    expect(context.routeConfig.groups).toEqual({ admin: true, ops: true, manage: true });
    const response = await handleAdminGet(new Request('https://example.test/booking/admin'), context);
    const body = await response.text();
    expect(body).toContain(`/booking/manage?token=${encodeURIComponent(seeded.operatorToken)}`);
  });
});

describe('createRouteContext (route entrypoint seam)', () => {
  it('overwrites the runtime-provided context.routeConfig with the resolved per-build one from virtual:bookkit/config', async () => {
    const unprefixedDefault = resolveRouteConfig('', { admin: true, ops: true, manage: true });
    const prefixedFromIntegration = resolveRouteConfig('/en', { admin: true, ops: false, manage: true });
    vi.doMock('virtual:bookkit/runtime', () => ({
      default: {
        config,
        async createContext() {
          return createBookkitContext({
            config,
            db: {} as D1Database,
            repo: fakeRepository(),
            providers: providers(),
            routeConfig: unprefixedDefault,
          });
        },
      },
    }));
    vi.doMock('virtual:bookkit/config', () => ({ default: prefixedFromIntegration }));

    const { createRouteContext } = await import('../src/routes/route-context');
    const context = await createRouteContext({ request: new Request('https://example.test/en/booking/admin') });
    expect(context.routeConfig).toEqual(prefixedFromIntegration);

    vi.doUnmock('virtual:bookkit/runtime');
    vi.doUnmock('virtual:bookkit/config');
  });
});
