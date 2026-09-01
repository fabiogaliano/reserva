// Plan 025 (design decision 4): defineCloudflareBookkitRuntime validates the admin-auth combination
// synchronously, before it returns a runtime definition, exactly like it already does for booking
// event hooks and (when providers isn't a factory) the payment provider — composing with, not
// replacing, that existing validation at the same runtime-definition boundary. Real behavior tests
// against the actual function, not a mock of it: every case here either throws synchronously (no
// context ever created) or returns a usable definition.
import { describe, expect, it } from 'vitest';
import { defineCloudflareBookkitRuntime } from '../src/runtime-context';
import { config as baseConfig } from './fixtures';

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

describe('defineCloudflareBookkitRuntime admin-auth validation', () => {
  it('throws synchronously naming both remedies when a protected group is enabled and neither admin.access nor adminAuth is configured', () => {
    expect(() => defineCloudflareBookkitRuntime(configWithoutAccess(), { providers: { payments } }))
      .toThrow(/admin\.access/);
    expect(() => defineCloudflareBookkitRuntime(configWithoutAccess(), { providers: { payments } }))
      .toThrow(/adminAuth/);
  });

  it('throws synchronously asking to remove one when both admin.access and adminAuth are configured', () => {
    expect(() => defineCloudflareBookkitRuntime(baseConfig, { providers: { payments }, adminAuth: async () => ({ subject: '' }) }))
      .toThrow(/remove/);
  });

  it('accepts admin.access alone (Cloudflare Access, the default) and returns a usable definition', () => {
    const definition = defineCloudflareBookkitRuntime(baseConfig, { providers: { payments } });
    expect(definition.config).toEqual(baseConfig);
  });

  it('accepts a custom adminAuth alone, with no admin.access configured', () => {
    const definition = defineCloudflareBookkitRuntime(configWithoutAccess(), { providers: { payments }, adminAuth: async () => ({ subject: '' }) });
    expect(definition.config.admin.access).toBeUndefined();
  });

  it('permits omitting auth entirely when both routes.admin and routes.ops are disabled', () => {
    const config = { ...configWithoutAccess(), routes: { admin: false, ops: false } };
    expect(() => defineCloudflareBookkitRuntime(config, { providers: { payments } })).not.toThrow();
  });

  it('still requires an auth path when only routes.ops is enabled (admin disabled)', () => {
    const config = { ...configWithoutAccess(), routes: { admin: false, ops: true } };
    expect(() => defineCloudflareBookkitRuntime(config, { providers: { payments } })).toThrow(/admin\.access/);
  });

  it('still requires an auth path when only routes.admin is enabled (ops disabled)', () => {
    const config = { ...configWithoutAccess(), routes: { admin: true, ops: false } };
    expect(() => defineCloudflareBookkitRuntime(config, { providers: { payments } })).toThrow(/admin\.access/);
  });
});
