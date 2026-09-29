import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reserva } from '../src/integration';
import config from '../examples/minimal/client-config';
import { runAstroConfigSetup } from './fixtures';

function setup(options: Record<string, unknown> = { config, runtimeEntrypoint: './examples/minimal/runtime.ts' }) {
  return runAstroConfigSetup(reserva(options as never));
}

describe('Astro integration entry', () => {
  it('rejects an invalid config during setup', () => {
    expect(() => setup({
      config: { ...config, booking: { holdMinutes: 10 } },
      runtimeEntrypoint: './examples/minimal/runtime.ts',
    })).toThrow(/holdMinutes/i);
  });

  it('rejects a missing runtime entrypoint during setup', () => {
    expect(() => setup({ config, runtimeEntrypoint: resolve('/tmp/no-reserva-runtime.ts') })).toThrow(/runtimeEntrypoint/);
  });
});
