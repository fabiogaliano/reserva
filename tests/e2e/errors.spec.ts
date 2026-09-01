import { test, expect } from '@playwright/test';

test('a garbage manage token shows the denied/recovery page, not raw JSON or a crash', async ({ page }) => {
  const response = await page.goto('/booking/manage?token=this-token-has-never-existed');
  expect(response?.status()).toBe(403);
  await expect(page.locator('h1')).toContainText('Link not valid');
  // Recoverable, not a dead end: a token entry form to retry with the right link.
  await expect(page.getByLabel('Booking token')).toBeVisible();
});

test('an unknown booking-confirmation session_id shows a recoverable not-found page, not a crash', async ({ page }) => {
  // No booking row was ever created for this session_id — handleStatus (src/handlers/index.ts)
  // reports `status: 'not_found'` for it (not a 500), and confirmationPage renders that as a
  // normal 200 page with a "start over" action rather than surfacing raw JSON or throwing.
  const response = await page.goto('/booking-confirmation?session_id=session-that-was-never-created');
  expect(response?.status()).toBe(200);
  await expect(page.locator('h1')).toContainText('Booking not found');
});

// Plan 022: the payment webhook route moved off the vendor's name
// (/api/booking/webhooks/stripe -> /api/booking/webhooks/payment). A stale deployment or a
// forgotten redirect would leave the old path answering, so this pins both sides at the HTTP layer
// against the real built worker: the new path is routed (it rejects an unsigned body rather than
// 404ing), and the old one no longer exists at all.
test('the payment webhook answers on its neutral path and the vendor-named one is gone', async ({ request }) => {
  const answered = await request.post('/api/booking/webhooks/payment', { data: 'not-a-signed-payload' });
  expect(answered.status()).not.toBe(404);

  const retired = await request.post('/api/booking/webhooks/stripe', { data: 'not-a-signed-payload' });
  expect(retired.status()).toBe(404);
});
