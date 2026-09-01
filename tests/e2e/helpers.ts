import { type Page, expect } from '@playwright/test';
import { format } from 'date-fns';

export interface BookingOpts {
  service: string;
  quantity: number;
  // Plan 017 (design decision 5): selects a non-default meeting point when the service declares 2+
  // (the widget pre-checks the first one, which is why every other caller omits this and still
  // books that first point unchanged). No-op when the service has 0-1 points, since the widget then
  // renders no such group to select from.
  meetingPointId?: string;
  // Plan 023 (design decision 1): the page hosting `opts.service`'s widget — defaults to the
  // homepage (oldTown). A location-less service is demoed from its own page (see river-cruise.astro).
  path?: string;
}

export async function createBooking(page: Page, opts: BookingOpts) {
  await page.goto(opts.path ?? '/');

  // 1. Select party size (accessible name, not the widget's internal CSS class — the class is a
  // styling hook the enhancer never renames, but a label survives markup/theming changes too).
  await page.getByLabel('How many people?').selectOption(String(opts.quantity));

  // 2. Fetch availability to find a valid date. Read from the API rather than hardcoding a date:
  // the fixture's schedule and cutoffs are relative to "today", so a fixed date would drift stale.
  const from = format(new Date(), 'yyyy-MM-dd');
  const to = format(new Date(Date.now() + 30 * 86_400_000), 'yyyy-MM-dd');
  const res = await page.request.get(`/api/booking/availability?service=${opts.service}&quantity=${opts.quantity}&from=${from}&to=${to}`);
  const availability = await res.json();
  const openDay = availability.days.find((d: any) => d.slots.length > 0);
  if (!openDay) {
    throw new Error(`No available days found for service ${opts.service} with ${opts.quantity} quantity`);
  }

  // 3. Pick the available date programmatically on the cally element to avoid timezone/locale label differences
  await page.evaluate((dateStr) => {
    const cal = document.querySelector('calendar-date') as any;
    if (cal && cal.value !== dateStr) {
      cal.value = dateStr;
      cal.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, openDay.date);

  // 4. Pick a slot — the first radio in the widget's slot radiogroup (scoped so this never
  // accidentally grabs the pickup-type radios rendered further down the same form).
  await page.getByRole('radiogroup').getByRole('radio').first().check();

  // 5. Pick pickup — omitted entirely for a location-less service (plan 023), whose widget renders
  // no pickupType radios at all.
  const pickupRadio = page.locator('input[name="pickupType"][value="default"]');
  if (await pickupRadio.count() > 0) await pickupRadio.check();

  // 5b. Pick a non-default meeting point when asked (see BookingOpts.meetingPointId) — the widget
  // pre-checks the first declared point, so this is skipped for the common case.
  if (opts.meetingPointId) {
    await page.locator(`input[name="meetingPointId"][value="${opts.meetingPointId}"]`).check();
  }

  // 6. Book
  await page.getByRole('button', { name: 'Continue to payment' }).click();

  // Wait for redirect to confirmation page
  await page.waitForURL(/\/booking-confirmation\?session_id=/);

  // Get the booking reference from the confirmation page. No fallback here: a missing reference
  // means the funnel didn't actually complete, which is a failure the caller must see, not paper
  // over with a placeholder that then fails a later assertion for an unrelated reason.
  const reference = await page.locator('.bk-ticket-ref .bk-mono').innerText();

  // Wait for *this* booking's confirmation entry specifically — the outbox is shared across every
  // spec in the run (workers: 1, see playwright.config.ts), so a later spec's booking would find
  // the outbox already non-empty from an earlier spec and could read a stale entry.
  await expect(async () => {
    const outboxRes = await page.request.get('/dev/outbox.json');
    const outbox = await outboxRes.json();
    expect(outbox.some((entry: any) => entry.reference === reference)).toBe(true);
  }).toPass();

  const outboxRes = await page.request.get('/dev/outbox.json');
  const outbox = await outboxRes.json();
  const entry = [...outbox].reverse().find((candidate: any) => candidate.reference === reference);

  return { reference, outboxEntry: entry };
}

// Drives the manage page's reschedule form into an available slot different from `currentStart`
// (a local ISO-with-offset instant, as returned by the manage API's `booking.start`). Exercises the
// served enhancer's calendar + slot picker (src/ui/manage-enhancer.ts) — the manage page always
// ships it when a reschedule is possible, so the native datetime-local fallback is not reachable
// from a JS-enabled browser and isn't exercised here.
export async function rescheduleViaManagePage(page: Page, currentStart: string): Promise<{ newStart: string }> {
  const form = page.locator('[data-bookkit-reschedule]');
  const service = await form.getAttribute('data-service');
  const quantity = await form.getAttribute('data-quantity');
  const from = await form.getAttribute('data-from');
  const to = await form.getAttribute('data-to');
  if (!service || !quantity || !from || !to) throw new Error('Reschedule form is missing its availability data attributes');

  const res = await page.request.get(`/api/booking/availability?service=${service}&quantity=${quantity}&from=${from}&to=${to}`);
  const availability = await res.json();
  let target: { date: string; start: string } | undefined;
  for (const day of availability.days) {
    const slot = day.slots.find((candidate: any) => candidate.start !== currentStart);
    if (slot) {
      target = { date: day.date, start: slot.start };
      break;
    }
  }
  if (!target) throw new Error('No alternative slot found to reschedule into');

  // The enhancer inserts this wrapper only once its own availability fetch resolves — waiting for
  // it is a real readiness signal (not a timeout guess) that `calendar.onchange` is already wired.
  await page.locator('.bk-cal-wrap').waitFor();
  await page.evaluate((dateStr) => {
    const cal = document.querySelector('.bk-cal-wrap calendar-date') as any;
    if (cal && cal.value !== dateStr) {
      cal.value = dateStr;
      cal.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, target.date);

  const timeLabel = target.start.slice(11, 16);
  await page.getByRole('button', { name: timeLabel }).click();
  await page.getByRole('button', { name: 'Reschedule booking' }).click();

  return { newStart: target.start.slice(0, 16) };
}
