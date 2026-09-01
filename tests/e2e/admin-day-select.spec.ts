import { type Locator, type Page, test, expect } from '@playwright/test';
import { addDays, format } from 'date-fns';

const TOUR = 'oldTown';

// The admin calendar renders the whole booking horizon (up to config.booking.maxHorizonDays), but
// the enhancer's month pager shows only one month at a time — clicking a day outside the initially
// active month first needs a "Next month" click or two. Cheap and current-date-independent, unlike
// hardcoding how many clicks are needed.
async function revealDay(page: Page, date: string): Promise<Locator> {
  const cell = page.locator(`.bk-day[data-date="${date}"]`);
  for (let attempt = 0; attempt < 4 && !(await cell.isVisible()); attempt += 1) {
    await page.getByRole('button', { name: 'Next month' }).click();
  }
  await expect(cell).toBeVisible();
  return cell;
}

async function closedOn(page: Page, date: string): Promise<boolean> {
  const availability = await (await page.request.get(
    `/api/booking/availability?service=${TOUR}&quantity=2&from=${date}&to=${date}`,
  )).json();
  const day = availability.days.find((d: any) => d.date === date);
  return day?.status === 'closed' && day?.slots.length === 0;
}

// Plan 014 item D (audit finding #14): the enhanced admin day calendar replaced the no-JS "To
// date" range field with undocumented Shift/Ctrl/Cmd-click selection, hid the always-native range
// input, and gave selected cells only a CSS class — no aria-pressed/role, no live-region
// announcement, and single-selection-only aria-current. This proves the accessible replacement:
// button semantics + aria-pressed on cells, a role="status" title announcing the count, the
// visible "To date" field staying in sync with a contiguous pointer selection, and a scattered
// selection correctly avoiding the "To date" shape (finding #14's actual bug: a scattered
// selection must never be describable as a contiguous range).

test('a contiguous 3-day pointer selection gets button semantics, aria-pressed, live-region copy, and matching visible inputs, and closes all three days', async ({ page }) => {
  const day1 = format(addDays(new Date(), 60), 'yyyy-MM-dd');
  const day2 = format(addDays(new Date(), 61), 'yyyy-MM-dd');
  const day3 = format(addDays(new Date(), 62), 'yyyy-MM-dd');

  await page.goto('/booking/admin');
  const cell1 = await revealDay(page, day1);
  await expect(cell1).toHaveAttribute('role', 'button');
  await cell1.click();
  const cell3 = await revealDay(page, day3);
  await cell3.click({ modifiers: ['Shift'] });

  const cell2 = page.locator(`.bk-day[data-date="${day2}"]`);
  await expect(cell1).toHaveAttribute('aria-pressed', 'true');
  await expect(cell2).toHaveAttribute('aria-pressed', 'true');
  await expect(cell3).toHaveAttribute('aria-pressed', 'true');

  const title = page.locator('[data-bookkit-day-title]');
  await expect(title).toHaveAttribute('role', 'status');
  await expect(title).toHaveText('3 days selected');

  const overrideForm = page.locator('#bk-override');
  await expect(overrideForm.locator('input[name="date"]')).toHaveValue(day1);
  await expect(overrideForm.locator('input[name="toDate"]')).toHaveValue(day3);
  // Contiguous shape: date+toDate only, no repeated hidden date fields (the STOP condition this
  // item's decision guards against — the two shapes must never both be populated).
  await expect(overrideForm.locator('input[data-bookkit-extra-date]')).toHaveCount(0);

  await overrideForm.getByRole('button', { name: 'Close 3 days' }).click();
  await expect(page).toHaveURL(new RegExp(`date=${day1}`));

  expect(await closedOn(page, day1)).toBe(true);
  expect(await closedOn(page, day2)).toBe(true);
  expect(await closedOn(page, day3)).toBe(true);
});

test('a scattered ctrl/cmd-click selection keeps repeated hidden date fields, blanks toDate, and closes only the selected days', async ({ page }) => {
  const day1 = format(addDays(new Date(), 65), 'yyyy-MM-dd');
  const gap = format(addDays(new Date(), 66), 'yyyy-MM-dd');
  const day3 = format(addDays(new Date(), 67), 'yyyy-MM-dd');

  await page.goto('/booking/admin');
  const cell1 = await revealDay(page, day1);
  await cell1.click();
  const cell3 = await revealDay(page, day3);
  // Meta (Cmd), not Control: on a macOS test runner, a simulated Control+click is delivered as a
  // context-menu gesture at the OS/Accessibility layer and never reaches the page as a 'click'
  // event at all — a Playwright/macOS quirk, not a bug in the app (which checks
  // `metaKey || ctrlKey` and so treats a real Ctrl-click, e.g. on Windows/Linux, identically).
  await cell3.click({ modifiers: ['Meta'] });

  const gapCell = page.locator(`.bk-day[data-date="${gap}"]`);
  await expect(cell1).toHaveAttribute('aria-pressed', 'true');
  await expect(cell3).toHaveAttribute('aria-pressed', 'true');
  await expect(gapCell).toHaveAttribute('aria-pressed', 'false');

  const overrideForm = page.locator('#bk-override');
  await expect(overrideForm.locator('input[name="toDate"]')).toHaveValue('');
  // The visible date input, not the hidden data-bookkit-extra-date field the scattered shape adds
  // — both share name="date", so scope by type to avoid a strict-mode ambiguity.
  await expect(overrideForm.locator('input[name="date"][type="date"]')).toHaveValue(day1);
  await expect(overrideForm.locator('input[data-bookkit-extra-date]')).toHaveValue(day3);

  await overrideForm.getByRole('button', { name: 'Close 2 days' }).click();
  await expect(page).toHaveURL(new RegExp(`date=${day1}`));

  expect(await closedOn(page, day1)).toBe(true);
  expect(await closedOn(page, day3)).toBe(true);
  expect(await closedOn(page, gap)).toBe(false);
});

test('toggling the final selected day off clears every submitted date field', async ({ page }) => {
  const day = format(addDays(new Date(), 69), 'yyyy-MM-dd');

  await page.goto('/booking/admin');
  const cell = await revealDay(page, day);
  await cell.click();
  await expect(cell).toHaveAttribute('aria-pressed', 'true');

  await cell.click({ modifiers: ['Meta'] });
  await expect(cell).toHaveAttribute('aria-pressed', 'false');

  const overrideForm = page.locator('#bk-override');
  await expect(overrideForm.locator('input[name="date"][type="date"]')).toHaveValue('');
  await expect(overrideForm.locator('input[name="toDate"]')).toHaveValue('');
  await expect(overrideForm.locator('input[data-bookkit-extra-date]')).toHaveCount(0);
});

test('keyboard-only: Space toggles a day, and typing a range into the two date inputs produces the same server-side result as pointer selection', async ({ page }) => {
  const soloDay = format(addDays(new Date(), 70), 'yyyy-MM-dd');
  const rangeStart = format(addDays(new Date(), 75), 'yyyy-MM-dd');
  const rangeMid = format(addDays(new Date(), 76), 'yyyy-MM-dd');
  const rangeEnd = format(addDays(new Date(), 77), 'yyyy-MM-dd');

  await page.goto('/booking/admin');

  // Part 1: Space toggles a single day (no mouse), matching a plain pointer click's result.
  const soloCell = await revealDay(page, soloDay);
  await soloCell.focus();
  await page.keyboard.press('Space');
  await expect(soloCell).toHaveAttribute('aria-pressed', 'true');
  const overrideForm = page.locator('#bk-override');
  await expect(overrideForm.locator('input[name="date"]')).toHaveValue(soloDay);
  await overrideForm.getByRole('button', { name: 'Close this day' }).click();
  await expect(page).toHaveURL(new RegExp(`date=${soloDay}`));
  expect(await closedOn(page, soloDay)).toBe(true);

  // Part 2: a 3-day range typed directly into the visible date/toDate inputs — no calendar
  // interaction at all — must reach the enhanced selection (title/aria-pressed follow the typed
  // values) and close the same three days a pointer shift-click range would.
  await page.goto('/booking/admin');
  const rangeStartCell = await revealDay(page, rangeStart);
  const form2 = page.locator('#bk-override');
  await form2.locator('input[name="date"]').fill(rangeStart);
  await form2.locator('input[name="toDate"]').fill(rangeEnd);
  await form2.locator('input[name="toDate"]').blur();

  await expect(rangeStartCell).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`.bk-day[data-date="${rangeMid}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`.bk-day[data-date="${rangeEnd}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-bookkit-day-title]')).toHaveText('3 days selected');

  await form2.getByRole('button', { name: 'Close 3 days' }).click();
  await expect(page).toHaveURL(new RegExp(`date=${rangeStart}`));
  expect(await closedOn(page, rangeStart)).toBe(true);
  expect(await closedOn(page, rangeMid)).toBe(true);
  expect(await closedOn(page, rangeEnd)).toBe(true);
});
