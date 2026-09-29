import { describe, expect, it } from 'vitest';
import { CSRF_SECRET_ENV_NAME } from '../src/admin-csrf';
import { OPERATOR_SECRET_NAME } from '../src/context';
import { reserva } from '../src/integration';
import { TOKEN_ENC_SECRET_NAME } from '../src/repo';
import config from '../examples/minimal/client-config';
import { runAstroConfigSetup } from './fixtures';

function updateConfigCalls(options: Record<string, unknown>): Array<Record<string, unknown>> {
  return runAstroConfigSetup(reserva(options as never)).updateConfigCalls;
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
    // The names the runtime actually reads, so renaming one without the schema fails here.
    const expectedNames = [OPERATOR_SECRET_NAME, CSRF_SECRET_ENV_NAME, TOKEN_ENC_SECRET_NAME];
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
