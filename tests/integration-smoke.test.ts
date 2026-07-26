import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Astro smoke fixture', () => {
  it('builds the TS-source integration with Cloudflare and emits injected routes', { timeout: 120_000 }, () => {
    const fixture = resolve(import.meta.dirname, '../examples/smoke-site');
    const astro = resolve(import.meta.dirname, '../node_modules/.bin/astro');
    expect(existsSync(resolve(fixture, 'astro.config.ts'))).toBe(true);
    expect(existsSync(resolve(fixture, 'src/pages/index.astro'))).toBe(true);
    execFileSync(astro, ['build'], { cwd: fixture, stdio: 'pipe' });
    const manifest = readFileSync(resolve(fixture, 'dist/server/entry.mjs'), 'utf8');
    for (const path of ['/api/booking/availability', '/api/booking/checkout', '/api/booking/webhooks/stripe', '/api/booking/feed', '/booking/admin', '/booking/manage', '/booking-confirmation']) {
      expect(manifest).toContain(`"route": "${path}"`);
    }
  });

  it('declares the payment fields and local token key exercised by the workers smoke test', () => {
    const fixture = resolve(import.meta.dirname, '../examples/smoke-site');
    const runtime = readFileSync(resolve(fixture, 'src/runtime.ts'), 'utf8');
    const wrangler = readFileSync(resolve(fixture, 'wrangler.jsonc'), 'utf8');
    expect(runtime).toContain('amountTotal: session.amountTotal');
    expect(runtime).toContain('currency: session.currency');
    expect(runtime).toContain("secretBindings: ['BOOKKIT_TOKEN_ENC_KEY', 'TOURFLOW_SHARED_SECRET']");
    expect(wrangler).toContain('"BOOKKIT_TOKEN_ENC_KEY"');
  });
});
