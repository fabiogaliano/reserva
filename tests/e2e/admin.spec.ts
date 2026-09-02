import { test, expect } from '@playwright/test';
import { addDays, format } from 'date-fns';
import { createBooking } from './helpers';

const TOUR = 'oldTown';

test('admin dashboard lists a booking by reference, and its operator manage link opens the manage page in the operator role', async ({ page }) => {
  const { reference } = await createBooking(page, { service: TOUR, quantity: 2 });

  await page.goto('/booking/admin');
  await expect(page.locator('h1')).toContainText('Booking admin', { ignoreCase: true });

  const row = page.locator('tr', { hasText: reference });
  await expect(row).toBeVisible();

  await row.getByRole('link', { name: 'Manage' }).click();
  await expect(page.locator('h1')).toContainText(reference);
  // Operator role, not customer: the admin dashboard only ever links the operator token.
  await expect(page.getByText('Operator view')).toBeVisible();
});

test('closing a day override removes it from availability, and clearing the override restores it', async ({ page, request }) => {
  // Far enough out (today's date range every other spec searches is the *earliest* open day) that
  // this override can't collide with a slot another spec in the same run already booked or is
  // about to book.
  const targetDate = format(addDays(new Date(), 25), 'yyyy-MM-dd');

  const availabilityBefore = await (await request.get(
    `/api/booking/availability?service=${TOUR}&quantity=2&from=${targetDate}&to=${targetDate}`,
  )).json();
  const dayBefore = availabilityBefore.days.find((d: any) => d.date === targetDate);
  expect(dayBefore?.slots.length).toBeGreaterThan(0);

  await page.goto('/booking/admin');
  const overrideForm = page.locator('#bk-override');
  await overrideForm.locator('input[name="date"]').fill(targetDate);
  await overrideForm.getByRole('button', { name: 'Close this day' }).click();

  await expect(page).toHaveURL(new RegExp(`date=${targetDate}`));

  const availabilityClosed = await (await request.get(
    `/api/booking/availability?service=${TOUR}&quantity=2&from=${targetDate}&to=${targetDate}`,
  )).json();
  const dayClosed = availabilityClosed.days.find((d: any) => d.date === targetDate);
  expect(dayClosed?.status).toBe('closed');
  expect(dayClosed?.slots).toEqual([]);

  // Clear the override — the page reloaded onto the same date after the close above, so the
  // override form is already scoped to targetDate.
  await page.locator('#bk-override').getByRole('button', { name: 'Reset to default' }).click();
  await expect(page).toHaveURL(new RegExp(`date=${targetDate}`));

  const availabilityRestored = await (await request.get(
    `/api/booking/availability?service=${TOUR}&quantity=2&from=${targetDate}&to=${targetDate}`,
  )).json();
  const dayRestored = availabilityRestored.days.find((d: any) => d.date === targetDate);
  expect(dayRestored?.status).not.toBe('closed');
  expect(dayRestored?.slots.length).toBeGreaterThan(0);
});

// Proves the embedded AdminDashboard.astro component (distinct from the built-in /booking/admin
// page above) works under the recommended RESERVA_CSRF_SECRET config, not just always-403ing. A
// distinct target date keeps this independent of the other day-override spec.
test('the embedded AdminDashboard component mints a working CSRF token and its override form succeeds (component -> handler, CSRF enabled)', async ({ page }) => {
  const targetDate = format(addDays(new Date(), 27), 'yyyy-MM-dd');

  await page.goto('/');
  const embeddedForm = page.locator('.bk-embed--admin form');
  await expect(embeddedForm).toBeVisible();
  // The component mints its own token at render time (src/components/AdminDashboard.astro); a
  // stale/missing one would 403 under this deployment's configured secret.
  await expect(embeddedForm.locator('input[name="csrf_token"]')).toHaveCount(1);

  await embeddedForm.locator('input[name="date"]').fill(targetDate);
  await embeddedForm.locator('input[name="capacity"]').fill('1');

  const [response] = await Promise.all([
    page.waitForResponse((res) => res.request().method() === 'POST' && res.url().includes('/booking/admin')),
    embeddedForm.getByRole('button', { name: 'Save' }).click(),
  ]);
  expect(response.status()).toBe(303);

  // The redirect lands on the full built-in admin page, confirming the mutation was accepted
  // rather than rejected.
  await expect(page).toHaveURL(new RegExp(`/booking/admin\\?.*date=${targetDate}`));
  await expect(page.locator('h1')).toContainText('Booking admin', { ignoreCase: true });
});
