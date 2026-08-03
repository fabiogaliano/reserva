import { test, expect } from '@playwright/test';
import { createBooking, rescheduleViaManagePage } from './helpers';

const TOUR = 'oldTown';

test('customer can cancel a booking within the cutoff, a cancellation email lands in the outbox, and the token is revoked indistinguishably from an unknown one', async ({ page, request }) => {
  const { reference, outboxEntry } = await createBooking(page, { tour: TOUR, people: 2 });

  const manageUrl = new URL(outboxEntry.customerManageUrl);
  const token = manageUrl.searchParams.get('token');
  if (!token) throw new Error('customerManageUrl did not carry a token');

  await page.goto(manageUrl.pathname + manageUrl.search);
  await expect(page.locator('h1')).toContainText(reference);

  // Click the 'Cancel booking' summary to open the disclosure
  await page.getByText('Cancel booking').click();

  // Click the actual cancel button
  await page.getByRole('button', { name: 'Yes, cancel this booking' }).click();

  // The customer is redirected to the manage page, which now rejects their revoked token — this
  // round trip only works because src/routes/booking/manage.ts serves `referrer-policy:
  // same-origin` (not `no-referrer`): the browser sends a real Origin on this same-origin POST, so
  // Astro's default checkOrigin lets it through.
  await expect(page.locator('h1')).toContainText('Link not valid');

  const outbox = await (await page.request.get('/dev/outbox.json')).json();
  const cancelEmail = outbox.find((entry: any) => entry.reference === reference && entry.event === 'booking.cancelled_by_customer');
  expect(cancelEmail).toBeTruthy();

  // Revocation indistinguishability: a revoked token and a token that never existed must produce
  // the same status and body, so a caller can never learn "this booking used to exist" from the
  // difference.
  const revoked = await request.get(`/api/booking/manage?token=${encodeURIComponent(token)}`);
  const garbage = await request.get(`/api/booking/manage?token=garbage-${Date.now()}`);
  expect(revoked.status()).toBe(403);
  expect(revoked.status()).toBe(garbage.status());
  expect(await revoked.json()).toEqual(await garbage.json());
});

test('customer can reschedule to another available slot, the manage page reflects the new time, and a reschedule email lands in the outbox', async ({ page, request }) => {
  const { reference, outboxEntry } = await createBooking(page, { tour: TOUR, people: 2 });

  const manageUrl = new URL(outboxEntry.customerManageUrl);
  const token = manageUrl.searchParams.get('token');
  if (!token) throw new Error('customerManageUrl did not carry a token');

  await page.goto(manageUrl.pathname + manageUrl.search);
  const before = await (await request.get(`/api/booking/manage?token=${encodeURIComponent(token)}`)).json();
  const currentStart: string = before.booking.start;

  const { newStart } = await rescheduleViaManagePage(page, currentStart);

  await expect(page.getByRole('status').filter({ hasText: 'rescheduled' })).toBeVisible();

  const after = await (await request.get(`/api/booking/manage?token=${encodeURIComponent(token)}`)).json();
  expect(after.booking.start.slice(0, 16)).toBe(newStart);
  expect(after.booking.start.slice(0, 16)).not.toBe(currentStart.slice(0, 16));

  const outbox = await (await page.request.get('/dev/outbox.json')).json();
  const rescheduleEmail = outbox.find((entry: any) => entry.reference === reference && entry.event === 'booking.rescheduled');
  expect(rescheduleEmail).toBeTruthy();
});

// Regression coverage for manage-enhancer.ts's dateKey() switch from local to UTC Date getters —
// the same cally/Date.UTC mismatch as BookingWidget's dateKey (see the twin test in
// funnel.spec.ts): with local getters, the reschedule calendar marks every open day as disallowed
// in any timezone behind UTC. The dev machine is UTC+1, where both agree, so only a pinned
// negative-offset timezone exercises this.
test.describe('reschedule calendar in a timezone behind UTC (regression: manage-enhancer dateKey)', () => {
  test.use({ timezoneId: 'America/New_York' });

  test('the reschedule calendar does not mark an open day as disallowed', async ({ page, request }) => {
    const { outboxEntry } = await createBooking(page, { tour: TOUR, people: 2 });

    const manageUrl = new URL(outboxEntry.customerManageUrl);
    await page.goto(manageUrl.pathname + manageUrl.search);

    // The enhancer inserts .bk-cal-wrap only after its availability fetch resolves, so this wait
    // guarantees isDateDisallowed is already assigned when the probe below calls it.
    await page.locator('.bk-cal-wrap').waitFor();
    const form = page.locator('[data-bookkit-reschedule]');
    const tour = await form.getAttribute('data-tour');
    const people = await form.getAttribute('data-people');
    const from = await form.getAttribute('data-from');
    const to = await form.getAttribute('data-to');
    if (!tour || !people || !from || !to) throw new Error('Reschedule form is missing its availability data attributes');

    const availability = await (await request.get(`/api/booking/availability?tour=${tour}&people=${people}&from=${from}&to=${to}`)).json();
    const openDay = availability.days.find((d: any) => d.slots.length > 0);
    if (!openDay) throw new Error('No available day found to probe isDateDisallowed against');

    // Probes the enhancer's assigned isDateDisallowed with a Date built exactly the way cally
    // builds them (Date.UTC), the precise code path the bug lived in.
    const disallowed = await page.evaluate((dateStr: string) => {
      const cal = document.querySelector('.bk-cal-wrap calendar-date') as any;
      const [year, month, day] = dateStr.split('-').map(Number);
      if (year === undefined || month === undefined || day === undefined) {
        throw new Error(`Unparseable date string: ${dateStr}`);
      }
      return cal.isDateDisallowed(new Date(Date.UTC(year, month - 1, day)));
    }, openDay.date);
    expect(disallowed).toBe(false);
  });
});
