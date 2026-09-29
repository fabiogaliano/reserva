import { test, expect } from '@playwright/test';
import { createBooking } from './helpers';

// oldTown declares two free meeting points instead of the single-point shorthand. Proves the
// SECOND point survives the whole path — not just that "a" point round-trips, which the
// pre-checked default already covers everywhere else.

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
