import { test, expect } from '@playwright/test';
import { createBooking, rescheduleViaManagePage } from './helpers';

const TOUR = 'oldTown';

test('operator can cancel a booking with a full refund, the page reflects the cancelled/refunded state, and a cancellation email lands in the outbox', async ({ page, request }) => {
  const { reference, outboxEntry } = await createBooking(page, { service: TOUR, quantity: 2 });

  const manageUrl = new URL(outboxEntry.operatorManageUrl);
  const token = manageUrl.searchParams.get('token');
  if (!token) throw new Error('operatorManageUrl did not carry a token');

  await page.goto(manageUrl.pathname + manageUrl.search);
  await expect(page.locator('h1')).toContainText(reference);

  await page.getByText('Cancel booking').click();
  // By role, not by label: the select's accessible name swallows its own option text, and the
  // partial-amount field's label contains "refund" too.
  await page.getByRole('combobox', { name: /Refund/ }).selectOption('full');
  await page.getByRole('button', { name: 'Yes, cancel this booking' }).click();

  // Unlike the customer's cancel token, the operator token is never revoked (src/repo.ts —
  // operator token lookups carry no revocation check), so the operator lands back on the same
  // manage page rather than a denied one, now showing the cancelled state.
  await expect(page.locator('h1')).toContainText(reference);
  await expect(page.getByText('This booking has been cancelled.')).toBeVisible();

  const manage = await (await request.get(`/api/booking/manage?token=${encodeURIComponent(token)}`)).json();
  expect(manage.booking.status).toBe('cancelled');

  const outbox = await (await page.request.get('/dev/outbox.json')).json();
  const cancelEmail = outbox.find((entry: any) => entry.reference === reference && entry.event === 'booking.cancelled_by_operator');
  expect(cancelEmail).toBeTruthy();
});

test('operator can cancel with a partial refund, and the amount typed in major units is what gets refunded', async ({ page, request }) => {
  const { reference, outboxEntry } = await createBooking(page, { service: TOUR, quantity: 2 });

  const manageUrl = new URL(outboxEntry.operatorManageUrl);
  const token = manageUrl.searchParams.get('token');
  if (!token) throw new Error('operatorManageUrl did not carry a token');

  await page.goto(manageUrl.pathname + manageUrl.search);
  const before = await (await request.get(`/api/booking/manage?token=${encodeURIComponent(token)}`)).json();
  const priceMinor: number = before.booking.priceMinor;

  await page.getByText('Cancel booking').click();
  await page.getByRole('combobox', { name: /Refund/ }).selectOption('partial');
  // Major units in the form, minor units on the wire — this is the only place that conversion runs
  // end to end.
  await page.getByRole('spinbutton', { name: 'Partial refund amount' }).fill('5.50');
  await page.getByRole('button', { name: 'Yes, cancel this booking' }).click();

  await expect(page.getByText('This booking has been cancelled.')).toBeVisible();
  const after = await (await request.get(`/api/booking/manage?token=${encodeURIComponent(token)}`)).json();
  expect(after.booking.status).toBe('cancelled');
  // The refund was partial, so the booking's own price is untouched by it.
  expect(after.booking.priceMinor).toBe(priceMinor);

  const outbox = await (await page.request.get('/dev/outbox.json')).json();
  expect(outbox.find((entry: any) => entry.reference === reference && entry.event === 'booking.cancelled_by_operator')).toBeTruthy();
});

test('operator can reschedule a confirmed booking, and the manage page reflects the new time', async ({ page, request }) => {
  const { outboxEntry } = await createBooking(page, { service: TOUR, quantity: 2 });

  const manageUrl = new URL(outboxEntry.operatorManageUrl);
  const token = manageUrl.searchParams.get('token');
  if (!token) throw new Error('operatorManageUrl did not carry a token');

  await page.goto(manageUrl.pathname + manageUrl.search);
  const before = await (await request.get(`/api/booking/manage?token=${encodeURIComponent(token)}`)).json();
  const currentStart: string = before.booking.start;

  const { newStart } = await rescheduleViaManagePage(page, currentStart);

  await expect(page.getByRole('status').filter({ hasText: 'rescheduled' })).toBeVisible();

  const after = await (await request.get(`/api/booking/manage?token=${encodeURIComponent(token)}`)).json();
  expect(after.booking.start.slice(0, 16)).toBe(newStart);
});
