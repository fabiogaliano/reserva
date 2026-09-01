import { test, expect } from '@playwright/test';
import { createBooking } from './helpers';

test('Full happy path: book and manage as customer', async ({ page }) => {
  const { reference, outboxEntry } = await createBooking(page, { service: 'oldTown', quantity: 2 });

  expect(reference).toBeTruthy();

  // The confirmation page should show confirmed state
  await expect(page.locator('.bk-badge--ok')).toBeVisible();

  // Outbox should have the confirmation email
  expect(outboxEntry.event).toBe('booking.confirmed');
  expect(outboxEntry.reference).toBe(reference);
  expect(outboxEntry.customerManageUrl).toBeTruthy();

  // Open manage page in customer role (extract path since outbox uses absolute url with default config port)
  const manageUrl = new URL(outboxEntry.customerManageUrl);
  await page.goto(manageUrl.pathname + manageUrl.search);
  await expect(page.locator('h1')).toContainText(reference);
});

// Regression coverage for BookingWidget.astro's dateKey() switch from local to UTC Date getters:
// the vendored cally calendar builds the Date objects it hands to isDateDisallowed via
// `new Date(Date.UTC(...))` (node_modules/cally/dist/cally.js), so local getters read back the
// previous calendar day in any timezone behind UTC — every day would key to the wrong date and the
// calendar would show every open day as disallowed. The dev machine this suite was written on is
// UTC+1, where local and UTC getters happen to agree, so nothing exercises this without pinning a
// negative-offset timezone here.
test.describe('booking funnel in a timezone behind UTC (regression: BookingWidget dateKey)', () => {
  test.use({ timezoneId: 'America/New_York' });

  test('the calendar does not mark an open day as disallowed, and the booking completes', async ({ page, request }) => {
    await page.goto('/');
    await page.getByLabel('How many people?').selectOption('2');
    // Give the initial availability fetch a moment to populate `isDateDisallowed` before probing it.
    await expect(page.getByRole('radiogroup').getByRole('radio').first()).toBeVisible();

    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const availability = await (await request.get(`/api/booking/availability?service=oldTown&quantity=2&from=${from}&to=${to}`)).json();
    const openDay = availability.days.find((d: any) => d.slots.length > 0);
    if (!openDay) throw new Error('No available day found to probe isDateDisallowed against');

    // Calls the widget's actual assigned isDateDisallowed with a Date built exactly the way cally
    // builds it (Date.UTC), so this exercises the precise code path the bug lived in rather than
    // the calendar's shadow-DOM rendering (which the fix doesn't otherwise change observably).
    const disallowed = await page.evaluate((dateStr: string) => {
      const cal = document.querySelector('calendar-date') as any;
      const parts = dateStr.split('-').map(Number);
      const [year, month, day] = parts;
      if (year === undefined || month === undefined || day === undefined) {
        throw new Error(`Unparseable date string: ${dateStr}`);
      }
      return cal.isDateDisallowed(new Date(Date.UTC(year, month - 1, day)));
    }, openDay.date);
    expect(disallowed).toBe(false);

    const { reference } = await createBooking(page, { service: 'oldTown', quantity: 2 });
    expect(reference).toBeTruthy();
    await expect(page.locator('.bk-badge--ok')).toBeVisible();
  });
});
