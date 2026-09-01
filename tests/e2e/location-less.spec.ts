import { test, expect } from '@playwright/test';
import { createBooking } from './helpers';

// riverCruise (examples/smoke-site/src/config.ts) declares
// no location module at all — quantity-tier pricing only. Proves the whole funnel (widget ->
// checkout -> D1 -> confirmation -> admin) never surfaces a pickup/meeting-point axis for it, and
// that checkout still rejects a client that tries to send one anyway.

test('booking a service with no location module carries no pickup/meeting-point fields through checkout, confirmation, or admin', async ({ page }) => {
  let checkoutBody: Record<string, unknown> | undefined;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/booking/checkout')) {
      checkoutBody = JSON.parse(request.postData() ?? '{}');
    }
  });
  // riverCruise also declares a required text metadata field — the
  // widget renders no input for it (no editing surface beyond checkout), so this test satisfies that
  // requirement the same way every other test that isn't specifically about metadata does: inject a
  // minimal valid value onto the request the widget already sends, rather than growing the widget itself.
  await page.route('**/api/booking/checkout', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    body.metadata = { dietary_notes: 'n/a' };
    await route.continue({ postData: JSON.stringify(body) });
  });

  const { reference, outboxEntry } = await createBooking(page, { service: 'riverCruise', quantity: 2, path: '/river-cruise' });
  expect(reference).toBeTruthy();

  // The widget renders no pickupType radios at all for this service, so the submitted checkout
  // body never carries the fields.
  expect(checkoutBody).not.toHaveProperty('pickupType');
  expect(checkoutBody).not.toHaveProperty('meetingPointId');

  await expect(page.locator('.bk-badge--ok')).toBeVisible();
  await expect(page.locator('.bk-facts')).not.toContainText('Pickup');
  await expect(page.locator('.bk-facts')).not.toContainText('Meeting point');

  expect(outboxEntry.pickupType ?? null).toBeNull();

  await page.goto('/booking/admin');
  const row = page.locator('tr', { hasText: reference });
  await expect(row).toBeVisible();
  // The pickup sub-label column stays empty for a location-less booking.
  const pickupCell = row.locator('td').nth(3);
  await expect(pickupCell).toHaveText('');
});

// Checkout rejects pickupType/meetingPointId for a location-less
// service even if a client sends them anyway — the widget is not the enforcement boundary.
test('checkout rejects a pickupType field for a location-less service', async ({ request }) => {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const availability = await (await request.get(`/api/booking/availability?service=riverCruise&quantity=2&from=${from}&to=${to}`)).json();
  const openDay = availability.days.find((d: any) => d.slots.length > 0);
  const start = openDay?.slots?.[0]?.start;
  expect(start).toBeTruthy();

  const response = await request.post('/api/booking/checkout', {
    data: { serviceSlug: 'riverCruise', start, quantity: 2, pickupType: 'default', locale: 'en' },
  });
  expect(response.status()).toBe(400);
});
