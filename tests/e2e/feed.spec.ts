import { test, expect } from '@playwright/test';
import { createBooking } from './helpers';

test('feed rejects a missing bearer and a wrong bearer with the same 403 shape', async ({ request }) => {
  const since = new Date(0).toISOString();

  const missing = await request.get(`/api/booking/feed?since=${since}`);
  // The plan this suite was written from expected 401 for bad auth; the handler
  // (handleFeed, src/handlers/index.ts) actually throws HttpError(403, 'forbidden', ...) for both
  // a missing and a wrong bearer — asserting the library's actual behavior here, not the plan's
  // assumption (library changes are out of scope for this suite).
  expect(missing.status()).toBe(403);
  expect(await missing.json()).toMatchObject({ error: { code: 'forbidden', message: expect.any(String) } });

  const wrongBearer = await request.get(`/api/booking/feed?since=${since}`, {
    headers: { Authorization: 'Bearer not-the-real-secret' },
  });
  expect(wrongBearer.status()).toBe(403);
  expect(await wrongBearer.json()).toMatchObject({ error: { code: 'forbidden', message: expect.any(String) } });
});

test('feed authorized with the correct bearer returns the booking events for a booking created in this test', async ({ page, request }) => {
  const since = new Date(Date.now() - 60_000).toISOString();

  const { reference } = await createBooking(page, { tour: 'oldTown', people: 2 });

  const authorized = await request.get(`/api/booking/feed?since=${since}`, {
    headers: { Authorization: 'Bearer local-tourflow-secret' },
  });
  expect(authorized.status()).toBe(200);
  const body = await authorized.json();
  expect(Array.isArray(body.bookings)).toBe(true);
  const event = body.bookings.find((b: any) => b.reference === reference);
  expect(event).toBeTruthy();
  expect(event.status).toBe('confirmed');
});
