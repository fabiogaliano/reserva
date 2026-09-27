import { test, expect } from '@playwright/test';
import { addDays, format } from 'date-fns';
import { createBooking } from './helpers';

const TOUR = 'oldTown';

test('admin dashboard lists a booking by reference, and its operator manage link opens the manage page in the operator role', async ({ page }) => {
  const { reference } = await createBooking(page, { service: TOUR, quantity: 2 });

  await page.goto('/booking/admin');
  await expect(page.locator('h1')).toHaveText('Dashboard');

  // A booking row is a disclosure: the summary carries the customer and the panel carries the
  // reference, so the row has to be opened before either is on screen.
  const row = page.locator('.bk-booking', { hasText: reference });
  await expect(row).toBeVisible();
  await row.locator('summary').click();
  await expect(row.getByText(reference)).toBeVisible();

  await row.getByRole('link', { name: 'Manage booking' }).click();
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
    `/api/booking/availability?serviceSlug=${TOUR}&quantity=2&from=${targetDate}&to=${targetDate}`,
  )).json();
  const dayBefore = availabilityBefore.days.find((d: any) => d.date === targetDate);
  expect(dayBefore?.slots.length).toBeGreaterThan(0);

  // A day link (calendar cell, glance card) is a plain ?date= URL, so this is the same page the
  // operator lands on by picking the day.
  await page.goto(`/booking/admin?tab=availability&date=${targetDate}`);
  const overrideForm = page.locator('#bk-override');
  await expect(overrideForm.locator('input[name="date"]')).toHaveValue(targetDate);
  await overrideForm.getByRole('button', { name: 'Close this day' }).click();

  await expect(page).toHaveURL(new RegExp(`date=${targetDate}`));

  const availabilityClosed = await (await request.get(
    `/api/booking/availability?serviceSlug=${TOUR}&quantity=2&from=${targetDate}&to=${targetDate}`,
  )).json();
  const dayClosed = availabilityClosed.days.find((d: any) => d.date === targetDate);
  expect(dayClosed?.status).toBe('closed');
  expect(dayClosed?.slots).toEqual([]);

  // Clear the override — the page reloaded onto the same date after the close above, so the
  // override form is already scoped to targetDate, and a closed day offers Reopen in place of
  // the capacity controls.
  await expect(page.locator('#bk-override').getByRole('button', { name: 'Close this day' })).toBeHidden();
  await page.locator('#bk-override').getByRole('button', { name: 'Reopen day' }).click();
  await expect(page).toHaveURL(new RegExp(`date=${targetDate}`));

  const availabilityRestored = await (await request.get(
    `/api/booking/availability?serviceSlug=${TOUR}&quantity=2&from=${targetDate}&to=${targetDate}`,
  )).json();
  const dayRestored = availabilityRestored.days.find((d: any) => d.date === targetDate);
  expect(dayRestored?.status).not.toBe('closed');
  expect(dayRestored?.slots.length).toBeGreaterThan(0);
});
