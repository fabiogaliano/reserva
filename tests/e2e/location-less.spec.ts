import { test, expect } from '@playwright/test';
import { createBooking } from './helpers';

// riverCruise declares no location module — quantity-tier pricing only. Proves the whole funnel
// never surfaces a pickup/meeting-point axis for it, and checkout still rejects one anyway.

test('booking a service with no location module carries no pickup/meeting-point fields through checkout, confirmation, or admin', async ({ page, request }) => {
  let checkoutBody: Record<string, unknown> | undefined;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/booking/checkout')) {
      checkoutBody = JSON.parse(request.postData() ?? '{}');
    }
  });
  // riverCruise also declares a required text metadata field the widget renders no input for, so
  // this injects a minimal valid value onto the request rather than growing the widget.
  await page.route('**/api/booking/checkout', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    body.metadata = { dietary_notes: 'n/a' };
    await route.continue({ postData: JSON.stringify(body) });
  });

  const { reference, outboxEntry } = await createBooking(page, { service: 'riverCruise', quantity: 2, path: '/river-cruise' });
  expect(reference).toBeTruthy();

  // The widget renders no pickup radios at all for this service, so the submitted checkout body
  // never carries the fields — under either spelling.
  expect(checkoutBody).not.toHaveProperty('pickup');
  expect(checkoutBody).not.toHaveProperty('pickupType');
  expect(checkoutBody).not.toHaveProperty('meetingPointId');

  await expect(page.locator('.bk-badge--ok')).toBeVisible();
  await expect(page.locator('.bk-facts')).not.toContainText('Pickup');
  await expect(page.locator('.bk-facts')).not.toContainText('Meeting point');

  // The dev email log carries only the manage links, so the persisted pickup axis is asserted where
  // it actually lives: the token-protected manage response.
  const manageUrl = new URL(outboxEntry.operatorManageUrl);
  const token = manageUrl.searchParams.get('token');
  const manageJson = await (await request.get(`/api/booking/manage?token=${encodeURIComponent(token ?? '')}`)).json();
  expect(manageJson.booking).toMatchObject({ pickup: null, pickupAddress: null, meetingPoint: null });

  await page.goto('/booking/admin');
  const row = page.locator('.bk-booking', { hasText: reference });
  await expect(row).toBeVisible();
  // A location-less booking has no place to name, so the row summary stops at the party size and
  // the opened row carries no pickup facts at all. The service reads as its localized title now;
  // the slug fallback is gone.
  await expect(row.locator('.bk-booking-sub')).toHaveText('River Cruise · 2 people');
  await row.locator('summary').click();
  await expect(row.locator('.bk-facts')).not.toContainText('Pickup');
  await expect(row.locator('.bk-facts')).not.toContainText('Meeting point');
});

// Checkout rejects pickup/meetingPointId for a location-less
// service even if a client sends them anyway — the widget is not the enforcement boundary.
test('checkout rejects a pickup field for a location-less service', async ({ request }) => {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const availability = await (await request.get(`/api/booking/availability?serviceSlug=riverCruise&quantity=2&from=${from}&to=${to}`)).json();
  const openDay = availability.days.find((d: any) => d.slots.length > 0);
  const start = openDay?.slots?.[0]?.start;
  expect(start).toBeTruthy();

  const response = await request.post('/api/booking/checkout', {
    data: { serviceSlug: 'riverCruise', start, quantity: 2, pickup: 'default', locale: 'en' },
  });
  expect(response.status()).toBe(400);
});
