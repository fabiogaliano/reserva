import { describe, expect, it } from 'vitest';
import { bookkit } from '../src/integration';
import config from '../examples/client-config';

function updateConfigCalls(options: Record<string, unknown>): Array<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = [];
  const integration = bookkit(options as never);
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

const baseOptions = { config, runtimeEntrypoint: './examples/runtime.ts' };

describe('bookkit() astro:env schema contribution', () => {
  it('declares every provider secret as an optional server secret string field by default', () => {
    const schema = envSchemaFrom(updateConfigCalls(baseOptions));
    expect(schema).toBeDefined();
    const expectedNames = [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'BREVO_API_KEY',
      'BOOKKIT_OPERATOR_SECRET',
      'GOOGLE_SA_EMAIL',
      'GOOGLE_SA_PRIVATE_KEY',
      'GOOGLE_IMPERSONATE_EMAIL',
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
