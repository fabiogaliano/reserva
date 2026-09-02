import { test, expect } from '@playwright/test';

// BookingWidget used to hardcode `id="bkw-date-label"`, so two instances on one page produced
// duplicate ids and an ambiguous aria-labelledby target. Proves the fix: distinct label ids, each
// calendar resolving to its own instance, both widgets independently usable.
test('two widget instances get distinct label ids and stay independently operable', async ({ page }) => {
  await page.goto('/two-widgets');

  const formA = page.locator('[data-widget-index="0"] form.bk-widget');
  const formB = page.locator('[data-widget-index="1"] form.bk-widget');
  await expect(formA).toBeVisible();
  await expect(formB).toBeVisible();

  const labelIdA = await formA.locator('.bkw-label[id]').getAttribute('id');
  const labelIdB = await formB.locator('.bkw-label[id]').getAttribute('id');
  expect(labelIdA).toBeTruthy();
  expect(labelIdB).toBeTruthy();
  expect(labelIdA).not.toBe(labelIdB);

  await expect(formA.locator('calendar-date')).toHaveAttribute('aria-labelledby', labelIdA!);
  await expect(formB.locator('calendar-date')).toHaveAttribute('aria-labelledby', labelIdB!);

  // Both instances load real availability independently.
  await expect(formA.getByRole('radiogroup').getByRole('radio').first()).toBeVisible();
  await expect(formB.getByRole('radiogroup').getByRole('radio').first()).toBeVisible();

  // Changing party size (and thus re-fetching availability) on A must not disturb B.
  await formA.getByLabel('How many people?').selectOption('3');
  await expect(formA.getByRole('button', { name: 'Continue to payment' })).toBeEnabled();
  await expect(formB.getByRole('button', { name: 'Continue to payment' })).toBeEnabled();
});
