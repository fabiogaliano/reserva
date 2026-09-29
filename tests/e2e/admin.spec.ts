import { test, expect } from '@playwright/test';
import { addDays, format } from 'date-fns';
import { booking } from '../fixtures';
import { openFixtureAdminPage } from './fixture-admin';
import { createBooking } from './helpers';

const TOUR = 'oldTown';

test('admin dashboard lists a booking by reference, and its operator manage link opens the manage page in the operator role', async ({ page }) => {
  const { reference } = await createBooking(page, { service: TOUR, quantity: 2 });

  await page.goto('/booking/admin');
  await expect(page.locator('body')).toHaveClass(/\bbk-page--admin\b/);

  // A booking row is a disclosure: the summary carries the customer and the panel carries the
  // reference, so the row has to be opened before either is on screen.
  const row = page.locator('.bk-booking', { hasText: reference });
  await expect(row).toBeVisible();
  await row.locator('summary').click();
  await expect(row.getByText(reference)).toBeVisible();

  await row.locator('a.bk-booking-open').click();
  await expect(page.locator('h1')).toContainText(reference);
  // Operator role, not customer: the admin dashboard only ever links the operator token, so the
  // page's forms post it back as operatorToken and never as a customer token.
  await expect(page.locator('input[type="hidden"][name="operatorToken"]').first()).toBeAttached();
  await expect(page.locator('input[name="token"]')).toHaveCount(0);
});

// Two open rows would already mean a second real booking in the scarce first days every other spec
// books into, so the list is served from fixtures (see fixture-admin.ts).
test('opening a booking row folds the one already open, so the list never turns into a wall of details', async ({ page, baseURL }) => {
  const rows = ['801', '802'].map((id, index) => booking({
    id, reference: `LVT-2026-${id}`, startsAt: `2026-06-2${index}T09:00:00.000Z`, endsAt: `2026-06-2${index}T10:00:00.000Z`,
    operatorToken: `op-${id}`, cancelToken: `cancel-${id}`,
  }));
  await openFixtureAdminPage(page, baseURL, { rows, activeTab: 'upcoming', editDate: '2026-06-20' });
  const [first, second] = rows.map((row) => page.locator('.bk-booking', { hasText: row.reference }));
  await first!.locator('summary').click();
  await expect(first!).toHaveAttribute('open', '');
  await second!.locator('summary').click();
  await expect(second!).toHaveAttribute('open', '');
  await expect(first!).not.toHaveAttribute('open');
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
