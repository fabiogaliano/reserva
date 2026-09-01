import { describe, expect, it, vi } from 'vitest';
import { reserva } from '../src/integration';
import config from '../examples/client-config';

const baseOptions = { config, runtimeEntrypoint: './examples/runtime.ts' };

// astro:config:done only needs `config` and `injectTypes`/`logger` from the hook payload;
// stub the rest as unused so this stays a narrow unit test of the adapter check.
function runConfigDone(adapterName: string | undefined) {
  const warn = vi.fn();
  const integration = reserva(baseOptions as never);
  const hook = integration.hooks['astro:config:done'];
  if (!hook) throw new Error('config:done hook is missing');
  hook({
    config: { adapter: adapterName ? { name: adapterName } : undefined } as never,
    injectTypes: () => ({ filename: '', content: '' }) as never,
    logger: { info() {}, warn, error() {} } as never,
  } as never);
  return { warn };
}

describe('reserva() astro:config:done adapter check', () => {
  it('proceeds silently for the exact @astrojs/cloudflare adapter', () => {
    const { warn } = runConfigDone('@astrojs/cloudflare');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns (does not throw) for a differently-named wrapper/fork adapter', () => {
    let warn: ReturnType<typeof vi.fn> = vi.fn();
    expect(() => {
      ({ warn } = runConfigDone('@my-org/cloudflare-fork'));
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/@astrojs\/cloudflare/);
  });

  it('warns (does not throw) when no adapter is configured', () => {
    let warn: ReturnType<typeof vi.fn> = vi.fn();
    expect(() => {
      ({ warn } = runConfigDone(undefined));
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/none/);
  });
});
