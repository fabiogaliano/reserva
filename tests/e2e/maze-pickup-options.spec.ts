import { test, expect } from '@playwright/test';
import { format } from 'date-fns';

// Plan 018 (design decision 9, step 6): books the 210 € combined option (custom_both) on the
// mazeRiverside tour (examples/smoke-site/src/config.ts) end-to-end — the only spec exercising a
// tour-declared pickupOptions widget through checkout, storage, and confirmation, not just the
// deprecated pickupTypes alias every other spec still books.
test('booking the 210 € custom pick-up & drop-off option shows the price and completes end to end', async ({ page }) => {
  await page.goto('/maze');
  await page.getByLabel('How many people?').selectOption('2');

  // Fetch availability to find a valid date/slot the same way helpers.createBooking does — this
  // spec is written out manually (rather than reusing that helper) so it can assert the price
  // mid-flow, right after selecting the option, before submitting.
  const from = format(new Date(), 'yyyy-MM-dd');
  const to = format(new Date(Date.now() + 30 * 86_400_000), 'yyyy-MM-dd');
  const res = await page.request.get(`/api/booking/availability?tour=mazeRiverside&people=2&from=${from}&to=${to}`);
  const availability = await res.json();
  const openDay = availability.days.find((d: any) => d.slots.length > 0);
  if (!openDay) throw new Error('No available days found for tour mazeRiverside with 2 people');

  await page.evaluate((dateStr) => {
    const cal = document.querySelector('calendar-date') as any;
    if (cal && cal.value !== dateStr) {
      cal.value = dateStr;
      cal.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, openDay.date);
  await page.getByRole('radiogroup').getByRole('radio').first().check();

  await page.locator('input[name="pickupType"][value="custom_both"]').check();
  await expect(page.locator('[data-bookkit-price-value]')).toContainText('210');

  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await page.waitForURL(/\/booking-confirmation\?session_id=/);

  const reference = await page.locator('.bk-ticket-ref .bk-mono').innerText();
  expect(reference).toBeTruthy();
  await expect(page.locator('.bk-badge--ok')).toBeVisible();

  await expect(async () => {
    const outboxRes = await page.request.get('/dev/outbox.json');
    const outbox = await outboxRes.json();
    expect(outbox.some((entry: any) => entry.reference === reference)).toBe(true);
  }).toPass();
});
