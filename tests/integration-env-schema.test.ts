import { describe, expect, it } from 'vitest';
import { reserva } from '../src/integration';
import config from '../examples/minimal/client-config';

function updateConfigCalls(options: Record<string, unknown>): Array<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = [];
  const integration = reserva(options as never);
  const hook = integration.hooks['astro:config:setup'];
  if (!hook) throw new Error('setup hook is missing');
  hook({
    config: { root: new URL('../', import.meta.url) } as never,
    command: 'build',
    isRestart: false,
    injectRoute: () => undefined,
    updateConfig: (next: any) => {
      calls.push(next as Record<string, unknown>);
      return {} as never;
    },
    logger: { info() {}, warn() {}, error() {} },
  } as never);
  return calls;
}

function envSchemaFrom(calls: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  const envCall = calls.find((call) => 'env' in call);
  const env = envCall?.env as { schema?: Record<string, unknown> } | undefined;
  return env?.schema;
}

const baseOptions = { config, runtimeEntrypoint: './examples/minimal/runtime.ts' };

describe('reserva() astro:env schema contribution', () => {
  // Vendor names are gone (plan item 12): a consumer who wants typed access to STRIPE_*/BREVO_*/
  // GOOGLE_* adds those entries to their own `env.schema`, so the core schema only declares the
  // secrets reserva itself reads.
  it("declares reserva's own secrets as optional server secret string fields by default", () => {
    const schema = envSchemaFrom(updateConfigCalls(baseOptions));
    expect(schema).toBeDefined();
    const expectedNames = [
      'RESERVA_OPERATOR_SECRET',
      'RESERVA_CSRF_SECRET',
      'RESERVA_TOKEN_ENC_KEY',
    ];
    expect(Object.keys(schema!).sort()).toEqual([...expectedNames].sort());
    for (const name of expectedNames) {
      expect(schema![name]).toMatchObject({ context: 'server', access: 'secret', optional: true });
    }
  });

  it('treats envSchema: true as the default behavior', () => {
    expect(envSchemaFrom(updateConfigCalls({ ...baseOptions, envSchema: true }))).toBeDefined();
  });

  it('skips the contribution entirely when envSchema is false', () => {
    const calls = updateConfigCalls({ ...baseOptions, envSchema: false });
    expect(calls.some((call) => 'env' in call)).toBe(false);
  });
});
