import { existsSync } from 'node:fs';
import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { reserva, virtualConfigId } from '../src/integration';
import { createReservaContext } from '../src/context';
import { handleAdminGet } from '../src/handlers';
import { renderManagePage } from '../src/ui/pages/manage-page';
import {
  normalizeRoutePrefix,
  resolveRouteConfig,
  routeManifest,
  type ReservaResolvedRouteConfig,
} from '../src/routes-manifest';
import clientConfig from '../examples/minimal/client-config';
import { validateConfig } from '../src/core/config';
import { booking, runAstroConfigSetup } from './fixtures';
import { fakeRepository, providers } from './fakes';

const config = validateConfig(clientConfig);

function setup(options: Record<string, unknown>, command: 'dev' | 'build' | 'preview' = 'build') {
  return runAstroConfigSetup(reserva(options as never), command);
}

const baseOptions = { config: clientConfig, runtimeEntrypoint: './examples/minimal/runtime.ts' };

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
    ['/en/fr', '/en/fr'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeRoutePrefix(input)).toBe(expected);
  });
});

describe('routePrefix validation at astro:config:setup', () => {
  it.each([
    ['/../etc', /routePrefix must not contain \\?"\.\.\\?"/],
    ['//other-host', /routePrefix must not contain consecutive slashes/],
    ['/en?x=1', /routePrefix must not contain a query string/],
    ['/en#f', /routePrefix must not contain a fragment/],
    ['https://evil.example', /routePrefix must not contain a URL scheme/],
    ['/a\\b', /routePrefix must not contain backslashes/],
    ['/en//fr', /routePrefix must not contain consecutive slashes/],
  ])('rejects traversal or URL syntax in %j with its rule-specific message', (routePrefix, message) => {
    expect(() => setup({ ...baseOptions, routePrefix })).toThrow(message);
  });
});

describe('route table generation (astro:config:setup)', () => {
  // Hard requirement: a consumer passing no new options must see the exact same route table as
  // before this feature existed — same patterns, same order.
  it('no options: default injected route patterns are byte-identical to the manifest, on demand, with real entrypoints', () => {
    const { routes } = setup(baseOptions);
    expect(routes.map((route) => route.pattern)).toEqual(routeManifest.map((entry) => entry.pattern));
    for (const route of routes) {
      expect(route.prerender).toBe(false);
      expect(existsSync(String(route.entrypoint))).toBe(true);
    }
  });

  it('routePrefix mounts every route under the prefix, in the same order', () => {
    const { routes } = setup({ ...baseOptions, routePrefix: '/en' });
    expect(routes.map((route) => route.pattern)).toEqual(routeManifest.map((entry) => `/en${entry.pattern}`));
  });

  it('an unnormalized prefix (no leading slash, trailing slash) still mounts correctly', () => {
    const { routes } = setup({ ...baseOptions, routePrefix: 'en/' });
    expect(routes.map((route) => route.pattern)).toEqual(routeManifest.map((entry) => `/en${entry.pattern}`));
  });

  // routes.admin/routes.ops live on `config.routes`, not on ReservaIntegrationOptions — the
  // integration reads the same validated config the runtime factory reads for admin-auth
  // selection, instead of two independently-settable options.
  it.each(['ops', 'admin'] as const)('config.routes: { %s: false } omits every route in that group and nothing else', (group) => {
    const { routes } = setup({ ...baseOptions, config: { ...clientConfig, routes: { [group]: false } } });
    // Anti-vacuity: an empty group would make the omission trivially true.
    expect(routeManifest.some((entry) => entry.group === group)).toBe(true);
    expect(routes.map((route) => route.pattern)).toEqual(
      routeManifest.filter((entry) => entry.group !== group).map((entry) => entry.pattern),
    );
  });

  it('rejects an invalid routePrefix at setup time, before any route is injected', () => {
    expect(() => setup({ ...baseOptions, routePrefix: '/en service' })).toThrow(/whitespace/);
  });

  function loadVirtualConfig(viteConfig: Record<string, unknown>): { config: unknown; routes: ReservaResolvedRouteConfig } {
    const plugins = (viteConfig.vite as { plugins: Array<{ resolveId(id: string): string | undefined; load(id: string): string | undefined }> }).plugins;
    const plugin = plugins.find((candidate) => candidate.resolveId(virtualConfigId) !== undefined);
    if (!plugin) throw new Error('route-config plugin not registered');
    const resolved = plugin.resolveId(virtualConfigId) as string;
    const source = plugin.load(resolved) as string;
    return JSON.parse(source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1));
  }

  it('exposes the validated config and the resolved (prefixed) paths and group flags through virtual:reserva/config', () => {
    const loaded = loadVirtualConfig(setup({ ...baseOptions, routePrefix: '/en', config: { ...clientConfig, routes: { ops: false } } }).viteConfig);
    expect(loaded.routes).toEqual(resolveRouteConfig('/en', { admin: true, ops: false, manage: true }));
    expect(loaded.routes.paths.checkout).toBe('/en/api/booking/checkout');
    // The config travels through the same module (plan item 12), so a runtime module no longer
    // imports reserva.config.ts itself. JSON round-tripped because that is how it reaches a reader.
    expect(loaded.config).toEqual(JSON.parse(JSON.stringify(validateConfig({ ...clientConfig, routes: { ops: false } }))));
  });

  // The admin gate's dev bypass (plan item 11) keys off this flag, so it must come from the build
  // command and nothing else: `astro build` and `astro preview` output can never carry it.
  it('marks the route config dev only for astro dev', () => {
    expect(loadVirtualConfig(setup(baseOptions, 'dev').viteConfig).routes.dev).toBe(true);
    expect(loadVirtualConfig(setup(baseOptions, 'build').viteConfig).routes.dev).toBe(false);
    expect(loadVirtualConfig(setup(baseOptions, 'preview').viteConfig).routes.dev).toBe(false);
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
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository([seeded], { tokenEncryptionKey: 'route-token-key' }),
      clock,
      adminAuth: async () => ({ subject: '' }),
      providers: providers(),
      secrets: async (name) => (name === 'RESERVA_TOKEN_ENC_KEY' ? 'route-token-key' : undefined),
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
    const context = createReservaContext({
      config,
      db: {} as D1Database,
      repo: fakeRepository([seeded], { tokenEncryptionKey: 'route-token-key' }),
      clock,
      adminAuth: async () => ({ subject: '' }),
      providers: providers(),
      secrets: async (name) => (name === 'RESERVA_TOKEN_ENC_KEY' ? 'route-token-key' : undefined),
    });

    expect(context.routeConfig.groups).toEqual({ admin: true, ops: true, manage: true });
    const response = await handleAdminGet(new Request('https://example.test/booking/admin'), context);
    const body = await response.text();
    expect(body).toContain(`/booking/manage?token=${encodeURIComponent(seeded.operatorToken)}`);
  });
});

describe('createRouteContext (route entrypoint seam)', () => {
  it('overwrites the runtime-provided context.routeConfig with the resolved per-build one from virtual:reserva/config', async () => {
    const unprefixedDefault = resolveRouteConfig('', { admin: true, ops: true, manage: true });
    const prefixedFromIntegration = resolveRouteConfig('/en', { admin: true, ops: false, manage: true });
    vi.doMock('virtual:reserva/runtime', () => ({
      default: {
        config,
        async createContext() {
          return createReservaContext({
            config,
            db: {} as D1Database,
            repo: fakeRepository(),
            providers: providers(),
            routeConfig: unprefixedDefault,
          });
        },
      },
    }));
    vi.doMock('virtual:reserva/config', () => ({ default: { config, routes: prefixedFromIntegration } }));

    const { createRouteContext } = await import('../src/routes/route-context');
    const context = await createRouteContext({ request: new Request('https://example.test/en/booking/admin') });
    expect(context.routeConfig).toEqual(prefixedFromIntegration);

    vi.doUnmock('virtual:reserva/runtime');
    vi.doUnmock('virtual:reserva/config');
  });
});
