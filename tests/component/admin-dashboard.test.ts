// Renders the actual compiled AdminDashboard.astro component, not just its source text (see
// vitest.component.config.ts). Proves it mints a working CSRF token from the Access-authenticated
// subject, matches the "no secret configured" fail-open, and fails visibly when Access fails.
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- resolved by vitest.component.config.ts's Astro Vite pipeline, not by tsc.
import AdminDashboard from '../../src/components/AdminDashboard.astro';
import { ACCESS_HEADER, SECRET_HEADER } from './fixtures/runtime';

function requestWith(headers: HeadersInit): Request {
  return new Request('https://example.test/', { headers });
}

async function render(headers: HeadersInit): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(AdminDashboard, { request: requestWith(headers) });
}

describe('AdminDashboard.astro', () => {
  it('mints and renders a hidden csrf_token field when a secret is configured and Access allows the request', async () => {
    const html = await render({ [ACCESS_HEADER]: 'claims', [SECRET_HEADER]: 'component-test-secret' });
    expect(html).toContain('<form method="post"');
    expect(html).toMatch(/<input type="hidden" name="csrf_token" value="[^"]+"/);
  });

  it('renders the form with no csrf_token field when RESERVA_CSRF_SECRET is not configured (mirrors the built-in admin page\'s fail-open)', async () => {
    const html = await render({ [ACCESS_HEADER]: 'allow' });
    expect(html).toContain('<form method="post"');
    expect(html).not.toContain('name="csrf_token"');
  });

  it('renders an access-required notice instead of the form when Access denies the request', async () => {
    const html = await render({ [ACCESS_HEADER]: 'deny', [SECRET_HEADER]: 'component-test-secret' });
    expect(html).not.toContain('<form');
    expect(html).toContain('Cloudflare Access authorization required to manage this booking.');
  });

  it('renders the notice when adminAuth throws', async () => {
    const html = await render({ [ACCESS_HEADER]: 'throw', [SECRET_HEADER]: 'component-test-secret' });
    expect(html).not.toContain('<form');
    expect(html).toContain('Cloudflare Access authorization required to manage this booking.');
  });

  it('renders the notice when no adminAuth is wired up at all', async () => {
    const html = await render({});
    expect(html).not.toContain('<form');
    expect(html).toContain('Cloudflare Access authorization required to manage this booking.');
  });
});
