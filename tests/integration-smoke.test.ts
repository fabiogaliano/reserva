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
    for (const path of ['/api/booking/availability', '/api/booking/checkout', '/api/booking/webhooks/payment', '/booking/admin', '/booking/manage', '/booking-confirmation']) {
      expect(manifest).toContain(`"route": "${path}"`);
    }
    // The vendor-named webhook path is retired, not aliased — a build that still emits it
    // would leave two entry points for the same signed payload.
    expect(manifest).not.toContain('"route": "/api/booking/webhooks/stripe"');
  });

  it('declares the payment fields and local token key exercised by the workers smoke test', () => {
    const fixture = resolve(import.meta.dirname, '../examples/smoke-site');
    const runtime = readFileSync(resolve(fixture, 'src/runtime.ts'), 'utf8');
    const wrangler = readFileSync(resolve(fixture, 'wrangler.jsonc'), 'utf8');
    expect(runtime).toContain('amountTotal: session.amountTotal');
    expect(runtime).toContain('currency: session.currency');
    expect(runtime).toContain("secretBindings: ['RESERVA_TOKEN_ENC_KEY', 'RESERVA_OPERATOR_SECRET', 'RESERVA_CSRF_SECRET']");
    expect(wrangler).toContain('"RESERVA_TOKEN_ENC_KEY"');
  });
});
