// src/routes/booking/manage.ts's POST used to read request.formData() unbounded. This proves
// the real Astro route entrypoint (not just the
// requestFormData helper it now calls, covered generically in tests/http-body-limits.test.ts)
// rejects an oversized form body with 413 before ever reaching token/action parsing. Needs the
// component Vite pipeline (see vitest.component.config.ts) because createRouteContext resolves
// virtual:reserva/runtime and virtual:reserva/config.
import type { APIContext } from 'astro';
import { describe, expect, it } from 'vitest';
import { POST } from '../../src/routes/booking/manage';

describe('manage.ts POST body size limit', () => {
  it('rejects a declared-oversized body with 413 before reaching form/token parsing', async () => {
    const request = new Request('https://example.test/api/booking/manage', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(256 * 1024 + 1) },
      body: 'action=cancel&token=whatever',
    });
    const response = await POST({ request, locals: {} } as unknown as APIContext);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'payload_too_large' } });
  });
});
