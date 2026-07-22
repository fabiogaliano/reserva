import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bookkit, virtualRuntimeId } from '../src/integration';
import config from '../examples/client-config';

function setup(options: Record<string, unknown> = { config, runtimeEntrypoint: './examples/runtime.ts' }) {
  const routes: Array<Record<string, unknown>> = [];
  // astro:config:setup calls updateConfig once per concern (vite plugin, env schema); merge every
  // call into one view rather than keeping only the last, matching Astro's own accumulating behavior.
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

describe('Astro integration entry', () => {
  it('validates at setup and injects every non-prerendered route', () => {
    const { routes } = setup();
    expect(routes).toHaveLength(16);
    expect(routes.every((route) => route.prerender === false)).toBe(true);
    expect(routes.map((route) => route.pattern)).toEqual(expect.arrayContaining([
      '/api/booking/availability',
      '/api/booking/checkout',
      '/api/booking/webhooks/stripe',
      '/api/booking/status',
      '/api/booking/manage',
      '/api/booking/cancel',
      '/api/booking/reschedule',
      '/api/booking/operator/cancel',
      '/api/booking/operator/reschedule',
      '/api/booking/operator/no-show',
      '/api/booking/feed',
      '/booking/admin',
      '/booking/manage',
      '/booking-confirmation',
    ]));
    for (const route of routes) expect(existsSync(String(route.entrypoint))).toBe(true);
  });

  it('resolves the virtual module to the explicit user runtime without serializing config', () => {
    const { viteConfig } = setup();
    const plugins = viteConfig?.vite && typeof viteConfig.vite === 'object' ? (viteConfig.vite as { plugins?: unknown[] }).plugins : undefined;
    const plugin = plugins?.[0] as { resolveId: (id: string) => string | undefined; load: (id: string) => string | undefined };
    const resolved = plugin.resolveId(virtualRuntimeId);
    expect(resolved).toBe('\0virtual:bookkit/runtime');
    const source = plugin.load(resolved as string);
    expect(source).toContain('examples/runtime.ts');
    expect(source).not.toContain('ECT');
  });

  it('rejects an invalid config during setup', () => {
    expect(() => setup({
      config: { ...config, booking: { ...config.booking, holdMinutes: 10 } },
      runtimeEntrypoint: './examples/runtime.ts',
    })).toThrow(/holdMinutes/i);
  });

  it('rejects a missing runtime entrypoint during setup', () => {
    expect(() => setup({ config, runtimeEntrypoint: resolve('/tmp/no-bookkit-runtime.ts') })).toThrow(/runtimeEntrypoint/);
  });
});
