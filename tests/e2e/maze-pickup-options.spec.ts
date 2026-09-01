import { test, expect } from '@playwright/test';
import { format } from 'date-fns';

// The deterministic test address the smoke fixture's fake payment session records for any option
// with requiresAddress: true (examples/smoke-site/src/runtime.ts, SMOKE_TEST_PICKUP_ADDRESS —
// plan 019 design decision 4). Kept as a literal here rather than imported so this spec doesn't
// reach into the smoke-site's internals, matching every other e2e spec in this directory.
const SMOKE_TEST_PICKUP_ADDRESS = '42 Fixture Lane, Testville';

async function bookMaze(page: import('@playwright/test').Page, pickupType: string, meetingPointId?: string) {
  await page.goto('/maze');
  await page.getByLabel('How many people?').selectOption('2');

  // Fetch availability to find a valid date/slot the same way helpers.createBooking does — this
  // spec is written out manually (rather than reusing that helper) so it can assert the price
  // mid-flow, right after selecting the option, before submitting.
  const from = format(new Date(), 'yyyy-MM-dd');
  const to = format(new Date(Date.now() + 30 * 86_400_000), 'yyyy-MM-dd');
  const res = await page.request.get(`/api/booking/availability?service=mazeRiverside&quantity=2&from=${from}&to=${to}`);
  const availability = await res.json();
  const openDay = availability.days.find((d: any) => d.slots.length > 0);
  if (!openDay) throw new Error('No available days found for service mazeRiverside with 2 quantity');

  await page.evaluate((dateStr) => {
    const cal = document.querySelector('calendar-date') as any;
    if (cal && cal.value !== dateStr) {
      cal.value = dateStr;
      cal.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, openDay.date);
  await page.getByRole('radiogroup').getByRole('radio').first().check();

  await page.locator(`input[name="pickupType"][value="${pickupType}"]`).check();
  if (meetingPointId) {
    await page.locator(`input[name="meetingPointId"][value="${meetingPointId}"]`).check();
  }

  let checkoutBody: Record<string, unknown> | undefined;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/booking/checkout')) {
      checkoutBody = JSON.parse(request.postData() ?? '{}');
    }
  });

  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await page.waitForURL(/\/booking-confirmation\?session_id=/);

  const reference = await page.locator('.bk-ticket-ref .bk-mono').innerText();
  expect(reference).toBeTruthy();
  await expect(page.locator('.bk-badge--ok')).toBeVisible();

  // Reuse the reference to select the matching outbox entry — the outbox is shared across every
  // spec in the run (workers: 1, see playwright.config.ts), so reading "latest" would be flaky.
  let outboxEntry: any;
  await expect(async () => {
    const outboxRes = await page.request.get('/dev/outbox.json');
    const outbox = await outboxRes.json();
    outboxEntry = [...outbox].reverse().find((entry: any) => entry.reference === reference);
    expect(outboxEntry).toBeTruthy();
  }).toPass();

  return { reference, outboxEntry, checkoutBody };
}

// Plan 018 (design decision 9, step 6) / plan 019 (design decision 6): books the 210 € combined
// option (custom_both — requiresAddress: true, usesMeetingPoint: false) on the mazeRiverside service
// (examples/smoke-site/src/config.ts) end-to-end, and follows it all the way to the server-stored
// confirmation and the protected manage flow — not just a client-computed price and a success
// badge, which would still pass an accidental server mapping to the 180 € option.
test('booking the 210 € custom pick-up & drop-off option shows the server-stored price and hides the meeting point everywhere', async ({ page, request }) => {
  await page.goto('/maze');
  await page.getByLabel('How many people?').selectOption('2');

  const from = format(new Date(), 'yyyy-MM-dd');
  const to = format(new Date(Date.now() + 30 * 86_400_000), 'yyyy-MM-dd');
  const res = await page.request.get(`/api/booking/availability?service=mazeRiverside&quantity=2&from=${from}&to=${to}`);
  const availability = await res.json();
  const openDay = availability.days.find((d: any) => d.slots.length > 0);
  if (!openDay) throw new Error('No available days found for service mazeRiverside with 2 quantity');

  await page.evaluate((dateStr) => {
    const cal = document.querySelector('calendar-date') as any;
    if (cal && cal.value !== dateStr) {
      cal.value = dateStr;
      cal.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, openDay.date);
  await page.getByRole('radiogroup').getByRole('radio').first().check();

  await page.locator('input[name="pickupType"][value="custom_both"]').check();
  // Plan 027 (design decision 1): this number now comes from POST /api/booking/quote — the widget
  // has no price table of its own — so seeing 210 here proves the quote endpoint prices the same
  // combination checkout charges for below.
  await expect(page.locator('[data-bookkit-price-value]')).toContainText('210');

  let checkoutBody: Record<string, unknown> | undefined;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/booking/checkout')) {
      checkoutBody = JSON.parse(req.postData() ?? '{}');
    }
  });

  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await page.waitForURL(/\/booking-confirmation\?session_id=/);
  expect(checkoutBody).not.toHaveProperty('meetingPointId');

  const reference = await page.locator('.bk-ticket-ref .bk-mono').innerText();
  expect(reference).toBeTruthy();
  await expect(page.locator('.bk-badge--ok')).toBeVisible();

  // Server-stored priceMinor, not the client's pre-checkout computation — an accidental server
  // mapping to the 180 € option would still show 210 on the widget but fail this assertion.
  await expect(page.locator('.bk-facts')).toContainText('210');
  // custom_both doesn't use a meeting point: neither of the service's two dock labels may leak into
  // the confirmation's facts or its calendar links.
  await expect(page.locator('.bk-facts')).not.toContainText('Riverside dock');
  await expect(page.locator('.bk-facts')).not.toContainText('Maze north gate');
  const googleCalendarHref = await page.locator('a', { hasText: 'Google Calendar' }).getAttribute('href');
  expect(googleCalendarHref ?? '').not.toContain(encodeURIComponent('Riverside dock'));
  expect(googleCalendarHref ?? '').not.toContain(encodeURIComponent('Maze north gate'));

  let outboxEntry: any;
  await expect(async () => {
    const outboxRes = await page.request.get('/dev/outbox.json');
    const outbox = await outboxRes.json();
    outboxEntry = [...outbox].reverse().find((entry: any) => entry.reference === reference);
    expect(outboxEntry).toBeTruthy();
  }).toPass();

  // The protected manage flow is the assertion surface for the persisted option, address, and
  // flags (design decision 3) — not a test-only DB route.
  const manageUrl = new URL(outboxEntry.operatorManageUrl);
  const token = manageUrl.searchParams.get('token');
  const manageJson = await (await request.get(`/api/booking/manage?token=${encodeURIComponent(token ?? '')}`)).json();
  expect(manageJson.booking).toMatchObject({
    pickupType: 'custom_both',
    pickupAddress: SMOKE_TEST_PICKUP_ADDRESS,
    pickupRequiresAddress: true,
    pickupUsesMeetingPoint: false,
  });

  await page.goto(manageUrl.pathname + manageUrl.search);
  await expect(page.locator('.bk-facts')).toContainText(SMOKE_TEST_PICKUP_ADDRESS);
  await expect(page.locator('.bk-facts')).not.toContainText('Riverside dock');
  await expect(page.locator('.bk-facts')).not.toContainText('Maze north gate');
});

// Plan 019 (design decision 6): custom_dropoff (requiresAddress: true, usesMeetingPoint: true)
// keeps the meeting-point group live — proves the two axes (pickupOptions, meetingPoints)
// compose: a declared option can require BOTH an address and a chosen point, and the second
// (non-default) point survives checkout, D1, confirmation, and the protected manage flow.
test('custom drop-off carries the selected second meeting point and the collected address through checkout, confirmation, and manage', async ({ page, request }) => {
  await page.goto('/maze');
  const group = page.locator('[data-bookkit-meeting-points]');
  await expect(group).toBeVisible();
  const points = group.locator('input[name="meetingPointId"]');
  await expect(points.first()).toBeEnabled();

  const { reference, outboxEntry, checkoutBody } = await bookMaze(page, 'custom_dropoff', 'gate');
  expect(checkoutBody).toMatchObject({ meetingPointId: 'gate' });
  expect(reference).toBeTruthy();

  // Confirmation shows the chosen point but never the address (privacy boundary, design decision 1).
  await expect(page.locator('.bk-facts')).toContainText('Maze north gate');
  await expect(page.locator('.bk-facts')).not.toContainText('Riverside dock');
  await expect(page.locator('.bk-facts')).not.toContainText(SMOKE_TEST_PICKUP_ADDRESS);

  const manageUrl = new URL(outboxEntry.operatorManageUrl);
  const token = manageUrl.searchParams.get('token');
  const manageJson = await (await request.get(`/api/booking/manage?token=${encodeURIComponent(token ?? '')}`)).json();
  expect(manageJson.booking).toMatchObject({
    pickupType: 'custom_dropoff',
    pickupAddress: SMOKE_TEST_PICKUP_ADDRESS,
    pickupRequiresAddress: true,
    pickupUsesMeetingPoint: true,
    meetingPoint: { label: 'Maze north gate' },
  });

  await page.goto(manageUrl.pathname + manageUrl.search);
  await expect(page.locator('.bk-facts')).toContainText(SMOKE_TEST_PICKUP_ADDRESS);
  await expect(page.locator('.bk-facts')).toContainText('Maze north gate');
});

// Plan 019 (design decision 6): a false usesMeetingPoint option (custom_pickup) hides and disables
// the meeting-point group and the checkout request omits meetingPointId — the declared-option
// counterpart to meeting-points.spec.ts's legacy default/custom pair, on a service that also declares
// real meeting points, so the two axes' interaction is exercised in the same browser test.
test('custom pick-up hides and disables the meeting-point group, and the checkout payload omits meetingPointId', async ({ page }) => {
  await page.goto('/maze');
  const group = page.locator('[data-bookkit-meeting-points]');
  const points = group.locator('input[name="meetingPointId"]');
  await expect(group).toBeVisible();
  await expect(points.first()).toBeChecked();

  await page.locator('input[name="pickupType"][value="custom_pickup"]').check();
  await expect(group).toBeHidden();
  await expect(points.first()).toBeDisabled();

  const { checkoutBody } = await bookMaze(page, 'custom_pickup');
  expect(checkoutBody).not.toHaveProperty('meetingPointId');
});
