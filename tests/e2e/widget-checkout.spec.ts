import { test, expect, type Page } from '@playwright/test';

// The example widget's checkout step: one checkout per submit, and error copy the visitor can act on.

function envelope(code: string, message: string, details?: Record<string, unknown>): string {
  return JSON.stringify({ error: { code, message, ...(details ? { details } : {}) } });
}

async function openWidget(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('radiogroup').getByRole('radio').first()).toBeVisible();
}

const submitButton = (page: Page) => page.locator('form.bk-widget button[type="submit"]');
const errorText = (page: Page) => page.locator('form.bk-widget [data-reserva-error]');

// The submit handler disabled the button, but any slot re-render (a date or party-size change
// while the checkout request was pending) re-enabled it, so a second click opened a second hold
// and a second payment session.
test('a checkout in flight is never sent twice, whatever re-renders the slot list meanwhile', async ({ page }) => {
  let checkoutRequests = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/booking/checkout', async (route) => {
    checkoutRequests += 1;
    await gate;
    await route.fulfill({ status: 409, contentType: 'application/json', body: envelope('slot_unavailable', 'The selected slot is not available') });
  });

  await openWidget(page);
  const submit = submitButton(page);
  const quantity = page.getByLabel('How many people?');
  await submit.click();
  await expect(submit).toBeDisabled();
  await expect(submit).toHaveText('Redirecting to secure payment…');
  // The party size is what is being charged, so it is locked while the request is pending.
  await expect(quantity).toBeDisabled();

  // A date change re-renders the slots through the calendar's own change handler. Re-selecting the
  // current day runs that same handler without depending on which other days earlier specs left open.
  const rerenderedDate = await page.evaluate(() => {
    const cal = document.querySelector('calendar-date') as HTMLElement & { value: string };
    cal.dispatchEvent(new Event('change', { bubbles: true }));
    return cal.value;
  });
  expect(rerenderedDate).toBeTruthy();
  // A party-size change reloads availability and re-renders through loadAvailability, the path that
  // used to re-enable the button. The control is locked, so its change event is dispatched directly.
  const availabilityReload = page.waitForResponse((response) => response.url().includes('/api/booking/availability'));
  await quantity.evaluate((element) => {
    const select = element as unknown as HTMLSelectElement;
    select.value = '3';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await availabilityReload;
  await expect(page.getByRole('radiogroup').getByRole('radio').first()).toBeVisible();

  await expect(submit).toBeDisabled();
  await expect(submit).toHaveText('Redirecting to secure payment…');
  await submit.click({ force: true });
  // A disabled button blocks clicks and Enter, but not a script's requestSubmit() (or a second
  // submit path), so the handler keeps its own guard.
  await page.evaluate(() => (document.querySelector('form.bk-widget') as HTMLFormElement).requestSubmit());
  await page.waitForTimeout(300);
  expect(checkoutRequests).toBe(1);

  release();
  await expect(errorText(page)).toHaveText('That time is no longer available. Please pick another one.');
  await expect(submit).toBeEnabled();
  await expect(submit).toHaveText('Continue to payment');
  await expect(quantity).toBeEnabled();
});

// Coming back from the payment page through the back/forward cache restored the page exactly as it
// was left: the button disabled on "Redirecting…" forever.
test('a page restored from the back/forward cache is bookable again', async ({ page }) => {
  // Never answered: from the page's point of view, it navigated away mid-checkout.
  await page.route('**/api/booking/checkout', () => {});
  await openWidget(page);
  const submit = submitButton(page);
  await submit.click();
  await expect(submit).toHaveText('Redirecting to secure payment…');

  // Chromium under automation does not put pages into the back/forward cache, so this dispatches
  // the event a restore fires.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(submit).toBeEnabled();
  await expect(submit).toHaveText('Continue to payment');
  await expect(page.getByLabel('How many people?')).toBeEnabled();
});

// showError printed `cause.message`: the server's English developer diagnostic, or the browser's
// "Failed to fetch".
const checkoutFailures = [
  { name: 'slot_unavailable', status: 409, body: envelope('slot_unavailable', 'The selected slot is not available'), copy: 'That time is no longer available. Please pick another one.' },
  { name: 'too_many_holds', status: 429, body: envelope('too_many_holds', 'Too many active holds for this client'), copy: 'There are too many unfinished bookings from your connection. Please wait a few minutes and try again.' },
  { name: 'calendar_unavailable', status: 503, body: envelope('calendar_unavailable', 'Calendar provider timed out'), copy: 'We could not confirm availability just now. Please try again in a moment.' },
  { name: 'validation_failed without a known field', status: 400, body: envelope('validation_failed', 'quantity must be an integer'), copy: 'Some of your details were not accepted. Please check the form and try again.' },
  { name: 'an unmapped code', status: 500, body: envelope('internal_error', 'D1_ERROR: no such table'), copy: 'Checkout failed. Please try again.' },
  { name: 'a non-envelope answer', status: 502, body: '<html>Bad gateway</html>', copy: 'Checkout failed. Please try again.' },
];

for (const failure of checkoutFailures) {
  test(`checkout failure (${failure.name}) shows localized copy, never the raw message`, async ({ page }) => {
    await page.route('**/api/booking/checkout', (route) => route.fulfill({ status: failure.status, contentType: 'application/json', body: failure.body }));
    await openWidget(page);
    await submitButton(page).click();
    await expect(errorText(page)).toHaveText(failure.copy);
  });
}

test('a checkout that never reaches the server says so, in the page language', async ({ page }) => {
  await page.route('**/api/booking/checkout', (route) => route.abort('internetdisconnected'));
  await openWidget(page);
  await submitButton(page).click();
  await expect(errorText(page)).toHaveText('Connection problem. Check your internet connection and try again.');
});

test('an availability request that never reaches the server shows the connection copy', async ({ page }) => {
  let fail = false;
  await page.route('**/api/booking/availability*', (route) => (fail ? route.abort('internetdisconnected') : route.continue()));
  await openWidget(page);
  fail = true;
  await page.getByLabel('How many people?').selectOption('2');
  await expect(errorText(page)).toHaveText('Connection problem. Check your internet connection and try again.');
});

// The form-oriented copy ("check the form") is for a submitted checkout; an availability read the
// visitor cannot fix keeps the availability copy.
test('a rejected availability request shows the availability copy, not the checkout form copy', async ({ page }) => {
  let fail = false;
  await page.route('**/api/booking/availability*', (route) => (fail
    ? route.fulfill({ status: 400, contentType: 'application/json', body: envelope('validation_failed', 'to must not be after the horizon') })
    : route.continue()));
  await openWidget(page);
  fail = true;
  await page.getByLabel('How many people?').selectOption('2');
  await expect(errorText(page)).toHaveText('Could not load availability. Please try again.');
});

test('slot_unavailable refreshes the slot list', async ({ page }) => {
  await page.route('**/api/booking/checkout', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: envelope('slot_unavailable', 'The selected slot is not available') }));
  await openWidget(page);
  const refresh = page.waitForRequest((request) => request.url().includes('/api/booking/availability'));
  await submitButton(page).click();
  await refresh;
  await expect(errorText(page)).toHaveText('That time is no longer available. Please pick another one.');
});

test('a validation_failed naming a declared detail points at that field by its label', async ({ page }) => {
  await page.route('**/api/booking/checkout', (route) => route.fulfill({
    status: 400,
    contentType: 'application/json',
    body: envelope('validation_failed', 'metadata.seat_pref must be one of: window, aisle (declared type: select)', { field: 'metadata.seat_pref', allowed: ['window', 'aisle'] }),
  }));
  await openWidget(page, '/river-cruise');
  await page.getByLabel('Dietary notes').fill('none');
  await submitButton(page).click();
  await expect(errorText(page)).toHaveText('Please check “Seat preference”.');
  const seat = page.getByLabel('Seat preference (optional)');
  await expect(seat).toHaveAttribute('aria-invalid', 'true');
  await expect(seat).toBeFocused();
});

// `remaining` counts further bookings of the chosen party size, not seats: "Only 2 left" read as
// two seats to a party of four.
test('the scarcity hint counts bookings, not seats', async ({ page }) => {
  const from = new Date().toISOString().slice(0, 10);
  await page.route('**/api/booking/availability*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      timezone: 'UTC',
      limitedThreshold: 2,
      days: [{
        date: from,
        status: 'limited',
        closedReason: null,
        slots: [
          { start: `${from}T09:00:00.000Z`, date: from, time: '09:00', remaining: 1 },
          { start: `${from}T10:00:00.000Z`, date: from, time: '10:00', remaining: 2 },
          { start: `${from}T11:00:00.000Z`, date: from, time: '11:00', remaining: null },
        ],
      }],
    }),
  }));
  await openWidget(page);
  await expect(page.locator('.bkw-slot-hint')).toHaveText(['Room for 1 more booking', 'Room for 2 more bookings']);
});
