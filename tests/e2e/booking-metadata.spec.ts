import { test, expect } from '@playwright/test';
import { createBooking } from './helpers';

// riverCruise (examples/smoke-site/src/config.ts) declares two metadata
// fields — a required `text` field and a `select` field. The widget renders no input for either
// (no editing surface beyond checkout), so this spec injects the field onto
// the checkout request the widget already sends, the same way any non-widget checkout consumer
// would. Proves the whole funnel: checkout validation -> D1 -> confirmation page -> both manage-
// page roles (customer and operator, the same renderer), with every value
// HTML-escaped.

const XSS_PAYLOAD = '<script>window.__bkMetadataXss = true;</script>"><img src=x onerror=alert(1)>';

test('consumer-declared metadata survives checkout, renders labeled on confirmation and both manage-page roles, and is HTML-escaped', async ({ page }) => {
  await page.route('**/api/booking/checkout', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    body.metadata = { dietary_notes: XSS_PAYLOAD, seat_pref: 'window' };
    await route.continue({ postData: JSON.stringify(body) });
  });

  const { reference, outboxEntry } = await createBooking(page, { service: 'riverCruise', quantity: 2, path: '/river-cruise' });
  expect(reference).toBeTruthy();

  // Confirmation page: labeled rows, the select value resolved to its declared option label (not
  // the raw stored value), and the hostile text field value never reaches the DOM unescaped.
  await expect(page.locator('.bk-facts')).toContainText('Dietary notes');
  await expect(page.locator('.bk-facts')).toContainText('Seat preference');
  await expect(page.locator('.bk-facts')).toContainText('Window seat');
  const confirmationHtml = await page.content();
  expect(confirmationHtml).not.toContain(XSS_PAYLOAD);
  expect(confirmationHtml).toContain('&lt;script&gt;');
  expect(await page.evaluate(() => (window as unknown as { __bkMetadataXss?: boolean }).__bkMetadataXss)).toBeUndefined();

  // Customer manage page: same labeled rows, same escaping.
  const customerManageUrl = new URL(outboxEntry.customerManageUrl);
  await page.goto(customerManageUrl.pathname + customerManageUrl.search);
  await expect(page.locator('.bk-facts')).toContainText('Dietary notes');
  await expect(page.locator('.bk-facts')).toContainText('Window seat');
  expect(await page.content()).not.toContain(XSS_PAYLOAD);

  // Operator manage page — this IS the admin "booking detail" surface: no
  // separate admin renderer, the role toggles inside the same manage page.
  const operatorManageUrl = new URL(outboxEntry.operatorManageUrl);
  await page.goto(operatorManageUrl.pathname + operatorManageUrl.search);
  await expect(page.locator('.bk-facts')).toContainText('Dietary notes');
  expect(await page.content()).not.toContain(XSS_PAYLOAD);
});

test('checkout rejects a missing required metadata field with a remediating 400', async ({ request }) => {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const availability = await (await request.get(`/api/booking/availability?service=riverCruise&quantity=2&from=${from}&to=${to}`)).json();
  const openDay = availability.days.find((d: any) => d.slots.length > 0);
  const start = openDay?.slots?.[0]?.start;
  expect(start).toBeTruthy();

  const response = await request.post('/api/booking/checkout', {
    data: { serviceSlug: 'riverCruise', start, quantity: 2, locale: 'en', metadata: { seat_pref: 'window' } },
  });
  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(body.error.message).toContain('dietary_notes');
});
