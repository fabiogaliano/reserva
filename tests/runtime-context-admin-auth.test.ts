// defineCloudflareReservaRuntime validates the admin-auth combination synchronously, composing
// with the existing booking-hooks/payment-provider validation rather than replacing it. Tests the
// real function: every case either throws synchronously or returns a usable definition.
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedClientConfig } from '../src/core/config';
import { defineCloudflareReservaRuntime } from '../src/runtime-context';
import { config as baseConfig } from './fixtures';

// The runtime factory no longer takes a config argument, so each case swaps the config the virtual
// module reports before calling it. A getter, not a frozen object: the factory reads at call time.
const virtual = vi.hoisted(() => ({ config: undefined as unknown as ResolvedClientConfig }));
vi.mock('virtual:reserva/config', async () => {
  const { resolveRouteConfig } = await import('../src/routes-manifest');
  const routes = resolveRouteConfig();
  return { default: { get config() { return virtual.config; }, routes } };
});

function runtimeFor(config: ResolvedClientConfig, options: Parameters<typeof defineCloudflareReservaRuntime>[0]) {
  virtual.config = config;
  return defineCloudflareReservaRuntime(options);
}

const payments = {
  createCheckout: async () => ({ url: 'https://checkout.test', sessionRef: 'cs_test' }),
  parseWebhook: async () => ({ id: 'evt_test', type: 'unknown' as const }),
  getSession: async () => ({ status: 'open' as const }),
  refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
};

// Real fixture config with `admin.access` dropped entirely — proves the whole admin surface can be
// declared with no `cloudflareaccess.com` string anywhere in it.
function configWithoutAccess(): typeof baseConfig {
  const { access: _omit, ...adminWithoutAccess } = baseConfig.admin;
  return { ...baseConfig, admin: adminWithoutAccess };
}

describe('defineCloudflareReservaRuntime admin-auth validation', () => {
  it('throws synchronously naming both remedies when a protected group is enabled and neither admin.access nor adminAuth is configured', () => {
    expect(() => runtimeFor(configWithoutAccess(), { providers: { payments } }))
      .toThrow(/admin\.access/);
    expect(() => runtimeFor(configWithoutAccess(), { providers: { payments } }))
      .toThrow(/adminAuth/);
  });

  it('throws synchronously asking to remove one when both admin.access and adminAuth are configured', () => {
    expect(() => runtimeFor(baseConfig, { providers: { payments }, adminAuth: async () => ({ subject: '' }) }))
      .toThrow(/remove/);
  });

  it('accepts admin.access alone (Cloudflare Access, the default) and returns a usable definition', () => {
    const definition = runtimeFor(baseConfig, { providers: { payments } });
    expect(definition.config).toEqual(baseConfig);
  });

  it('accepts a custom adminAuth alone, with no admin.access configured', () => {
    const definition = runtimeFor(configWithoutAccess(), { providers: { payments }, adminAuth: async () => ({ subject: '' }) });
    expect(definition.config.admin.access).toBeUndefined();
  });

  it('permits omitting auth entirely when both routes.admin and routes.ops are disabled', () => {
    const config = { ...configWithoutAccess(), routes: { admin: false, ops: false } };
    expect(() => runtimeFor(config, { providers: { payments } })).not.toThrow();
  });

  it('still requires an auth path when only routes.ops is enabled (admin disabled)', () => {
    const config = { ...configWithoutAccess(), routes: { admin: false, ops: true } };
    expect(() => runtimeFor(config, { providers: { payments } })).toThrow(/admin\.access/);
  });

  it('still requires an auth path when only routes.admin is enabled (ops disabled)', () => {
    const config = { ...configWithoutAccess(), routes: { admin: true, ops: false } };
    expect(() => runtimeFor(config, { providers: { payments } })).toThrow(/admin\.access/);
  });
});
