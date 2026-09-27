import { test, expect } from '@playwright/test';
import { createBooking } from './helpers';

// riverCruise declares a required text field and an optional select, which the widget renders
// from the catalog. Proves the whole funnel as a visitor drives it: the widget's inputs ->
// validation -> D1 -> confirmation -> both manage-page roles, with every value HTML-escaped.

const XSS_PAYLOAD = '<script>window.__bkMetadataXss = true;</script>"><img src=x onerror=alert(1)>';

test('consumer-declared metadata survives checkout, renders labeled on confirmation and both manage-page roles, and is HTML-escaped', async ({ page }) => {
  let checkoutBody: Record<string, unknown> | undefined;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/booking/checkout')) {
      checkoutBody = JSON.parse(request.postData() ?? '{}');
    }
  });

  const { reference, outboxEntry } = await createBooking(page, {
    service: 'riverCruise',
    quantity: 2,
    path: '/river-cruise',
    fields: { 'Dietary notes': XSS_PAYLOAD, 'Seat preference': 'Window seat' },
  });
  expect(reference).toBeTruthy();
  expect(checkoutBody?.metadata).toEqual({ dietary_notes: XSS_PAYLOAD, seat_pref: 'window' });

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

test('the widget renders the declared fields from the catalog and will not submit without the required one', async ({ page }) => {
  let checkoutRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/booking/checkout')) checkoutRequests += 1;
  });
  await page.goto('/river-cruise');
  await expect(page.getByRole('radiogroup').getByRole('radio').first()).toBeVisible();

  const dietary = page.getByLabel('Dietary notes');
  await expect(dietary).toHaveAttribute('required', '');
  await expect(dietary).toHaveAttribute('maxlength', '200');
  // The optional select says so, and offers its declared option labels.
  await expect(page.getByLabel('Seat preference (optional)')).toBeVisible();
  await expect(page.getByLabel('Seat preference (optional)').locator('option')).toHaveText(['', 'Window seat', 'Aisle seat']);

  await page.getByRole('button', { name: 'Continue to payment' }).click();
  // Native constraint validation stops the submit before any request is made.
  expect(await dietary.evaluate((element) => (element as HTMLInputElement).validity.valueMissing)).toBe(true);
  await page.waitForTimeout(300);
  expect(checkoutRequests).toBe(0);
});

test('a blank optional field is left out of the checkout body rather than sent empty', async ({ page }) => {
  let checkoutBody: Record<string, unknown> | undefined;
  await page.route('**/api/booking/checkout', async (route) => {
    checkoutBody = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'slot_unavailable', message: 'The selected slot is not available' } }) });
  });
  await page.goto('/river-cruise');
  await expect(page.getByRole('radiogroup').getByRole('radio').first()).toBeVisible();
  await page.getByLabel('Dietary notes').fill('vegan');
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await expect.poll(() => checkoutBody).toBeTruthy();
  expect(checkoutBody?.metadata).toEqual({ dietary_notes: 'vegan' });
});

test('checkout rejects a missing required metadata field with a remediating 400', async ({ request }) => {
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const availability = await (await request.get(`/api/booking/availability?serviceSlug=riverCruise&quantity=2&from=${from}&to=${to}`)).json();
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
