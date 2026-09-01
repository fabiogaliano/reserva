import { test, expect } from '@playwright/test';
import { createBooking } from './helpers';

// Plan 017 (design decision 5): the smoke-site's oldTown service now declares two free meeting
// points (examples/smoke-site/src/config.ts) instead of the single-point shorthand. These prove
// the SECOND point survives the whole path — widget selection, checkout, storage, and rendering
// back on the confirmation page — not just that "a" point round-trips (which the first-checked
// default already covered before this plan, and every other e2e spec that books oldTown still
// exercises unchanged, since the first point stays pre-checked).

test('booking the second meeting point carries its label through checkout to the confirmation page', async ({ page }) => {
  const { reference } = await createBooking(page, { service: 'oldTown', quantity: 2, meetingPointId: 'station' });
  expect(reference).toBeTruthy();

  await expect(page.locator('.bk-badge--ok')).toBeVisible();
  // The second declared point's label appears (facts.dd is a list — several rows match plain
  // text, so scope to the row containing it)...
  await expect(page.locator('.bk-facts')).toContainText('Riverside dock');
  // ...and the first (default-checked) point's label does not — proves the *chosen* point was
  // stored and resolved, not just whichever point happens to be first.
  await expect(page.locator('.bk-facts')).not.toContainText('Main square fountain');
});

test('custom pickup hides and disables the meeting-point group, and the checkout payload omits meetingPointId', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('How many people?').selectOption('2');
  await expect(page.getByRole('radiogroup').getByRole('radio').first()).toBeVisible();

  const group = page.locator('[data-bookkit-meeting-points]');
  const points = group.locator('input[name="meetingPointId"]');
  await expect(group).toBeVisible();
  await expect(points.first()).toBeChecked();

  await page.locator('input[name="pickupType"][value="custom"]').check();
  // hidden, not just visually collapsed (see the plan-014-style CSS trap this guards against in
  // src/ui/components.css) — and its radios disabled, which is what actually drops them from the
  // submitted FormData below.
  await expect(group).toBeHidden();
  await expect(points.first()).toBeDisabled();

  let checkoutBody: Record<string, unknown> | undefined;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/booking/checkout')) {
      checkoutBody = JSON.parse(request.postData() ?? '{}');
    }
  });
  await page.getByRole('button', { name: 'Continue to payment' }).click();
  await page.waitForURL(/\/booking-confirmation\?session_id=/);

  expect(checkoutBody).toBeDefined();
  expect(checkoutBody).not.toHaveProperty('meetingPointId');

  // Switching back to default pickup re-enables the group with its first option still checked.
  await page.goto('/');
  await page.getByLabel('How many people?').selectOption('2');
  await expect(group).toBeVisible();
  await expect(points.first()).toBeChecked();
  await expect(points.first()).toBeEnabled();
});
