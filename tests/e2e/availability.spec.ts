import { test, expect } from '@playwright/test';
import { format } from 'date-fns';
import { createBooking } from './helpers';

const TOUR = 'oldTown';
const PEOPLE = 2;

function dateRange() {
  const from = format(new Date(), 'yyyy-MM-dd');
  const to = format(new Date(Date.now() + 30 * 86_400_000), 'yyyy-MM-dd');
  return { from, to };
}

async function fetchAvailability(request: import('@playwright/test').APIRequestContext, quantity = PEOPLE) {
  const { from, to } = dateRange();
  const res = await request.get(`/api/booking/availability?service=${TOUR}&quantity=${quantity}&from=${from}&to=${to}`);
  return res.json();
}

test('availability response carries the exact fields the widget consumes', async ({ request }) => {
  const availability = await fetchAvailability(request);

  // BookingWidget.astro's client script (AvailabilityResponse/AvailabilityDay/AvailabilitySlot
  // interfaces) is the contract under test here — assert its shape, not a full-body snapshot, so
  // unrelated fields (e.g. `timezone`, which the widget never reads) can't fail this test.
  expect(typeof availability.limitedThreshold).toBe('number');
  expect(Array.isArray(availability.days)).toBe(true);
  expect(availability.days.length).toBeGreaterThan(0);

  const openDay = availability.days.find((d: any) => d.slots.length > 0);
  expect(openDay).toBeTruthy();
  expect(typeof openDay.date).toBe('string');
  expect(typeof openDay.status).toBe('string');
  expect(Array.isArray(openDay.slots)).toBe(true);

  const slot = openDay.slots[0];
  expect(typeof slot.start).toBe('string');
  expect(typeof slot.remaining).toBe('number');
  expect(typeof slot.remainingBookings).toBe('number');
});

test('booking a slot decreases its remaining count by one, and selling it out removes it from the widget and the API', async ({ page, request }) => {
  const before = await fetchAvailability(request);
  const openDay = before.days.find((d: any) => d.slots.length > 0);
  if (!openDay) throw new Error('No available day found to exercise capacity against');
  const targetStart = openDay.slots[0].start;
  const targetDate = openDay.date;
  // The fixture's oldTown service has no custom occupancyFor, so every booking (any party size)
  // consumes exactly one capacity unit — `remaining` here is already bounded by capacity.defaultCapacity
  // (3 in this fixture) and only ever counts down, so however many other specs' bookings already
  // landed on this exact slot before this test ran, driving it the rest of the way to zero (rather
  // than assuming a fixed starting count) keeps this test independent of run order.
  let remaining = openDay.slots[0].remaining;
  expect(remaining).toBeGreaterThan(0);

  while (remaining > 0) {
    await createBooking(page, { service: TOUR, quantity: PEOPLE });
    const after = await fetchAvailability(request);
    const day = after.days.find((d: any) => d.date === targetDate);
    const slot = day?.slots.find((s: any) => s.start === targetStart);
    remaining -= 1;
    if (remaining > 0) {
      expect(slot).toBeTruthy();
      expect(slot.remaining).toBe(remaining);
    } else {
      // Sold out: the slot must be gone from the API response entirely, not merely reported as 0.
      expect(slot).toBeUndefined();
    }
  }

  // The widget must not offer the sold-out slot either — re-render the same date and confirm no
  // radio carries its time label (other slots on the same day may still be open).
  await page.goto('/');
  await page.getByLabel('How many people?').selectOption(String(PEOPLE));
  await page.evaluate((dateStr) => {
    const cal = document.querySelector('calendar-date') as any;
    if (cal && cal.value !== dateStr) {
      cal.value = dateStr;
      cal.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, targetDate);
  const soldOutTime = targetStart.slice(11, 16);
  await expect(page.getByRole('radio', { name: soldOutTime })).toHaveCount(0);
});
