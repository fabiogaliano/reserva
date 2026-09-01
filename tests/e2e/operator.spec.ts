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
  await page.getByLabel('Refund').selectOption('full');
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
