import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Astro smoke fixture', () => {
  it('builds the TS-source integration with Cloudflare and emits injected routes', { timeout: 120_000 }, () => {
    const fixture = resolve(import.meta.dirname, '../examples/smoke-site');
    const astro = resolve(import.meta.dirname, '../node_modules/.bin/astro');
    expect(existsSync(resolve(fixture, 'astro.config.ts'))).toBe(true);
    expect(existsSync(resolve(fixture, 'src/pages/index.astro'))).toBe(true);
    execFileSync(astro, ['build'], { cwd: fixture, stdio: 'pipe' });
    // Astro decides per release whether the route manifest lives in entry.mjs or a chunk, and
    // whether its JSON is pretty-printed, so read the whole server bundle and match either form.
    const serverDir = resolve(fixture, 'dist/server');
    const chunksDir = resolve(serverDir, 'chunks');
    const manifest = [
      readFileSync(resolve(serverDir, 'entry.mjs'), 'utf8'),
      ...readdirSync(chunksDir).filter((name) => name.endsWith('.mjs')).map((name) => readFileSync(resolve(chunksDir, name), 'utf8')),
    ].join('\n');
    const routeEntry = (path: string): RegExp => new RegExp(`"route":\\s*"${path.replace(/[/-]/g, '\\$&')}"`);
    for (const path of ['/api/booking/availability', '/api/booking/checkout', '/api/booking/webhooks/payment', '/booking/admin', '/booking/manage', '/booking-confirmation']) {
      expect(manifest).toMatch(routeEntry(path));
    }
    // The vendor-named webhook path is retired, not aliased — a build that still emits it
    // would leave two entry points for the same signed payload.
    expect(manifest).not.toMatch(routeEntry('/api/booking/webhooks/stripe'));
  });

  it('declares the payment fields and local token key exercised by the workers smoke test', () => {
    const fixture = resolve(import.meta.dirname, '../examples/smoke-site');
    const runtime = readFileSync(resolve(fixture, 'src/runtime.ts'), 'utf8');
    const wrangler = readFileSync(resolve(fixture, 'wrangler.jsonc'), 'utf8');
    // The fakes moved into the library's `./dev` entry (plan item 15), so the reference consumer
    // wires them rather than hand-rolling them -- the payment fields the workers smoke test reads
    // are now the shipped provider's.
    expect(runtime).toContain('devProviders(');
    const devProviders = readFileSync(resolve(import.meta.dirname, '../src/dev/index.ts'), 'utf8');
    expect(devProviders).toContain('amountTotal: session.amountTotal');
    expect(devProviders).toContain('currency: session.currency');
    // Reserva's own secret names are readable without being restated, so the reference consumer must not list them.
    expect(runtime).not.toContain('secretBindings');
    expect(wrangler).toContain('"RESERVA_TOKEN_ENC_KEY"');
  });
});
