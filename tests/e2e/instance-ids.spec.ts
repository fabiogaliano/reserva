import { test, expect } from '@playwright/test';

// Each instance's script must scope itself to its own form: the per-instance label ids are proven
// at render time (tests/component/instance-ids.test.ts); only a real page shows two live scripts
// not reaching into each other.
test('two widget instances on one page stay independently operable', async ({ page }) => {
  await page.goto('/two-widgets');

  const formA = page.locator('[data-widget-index="0"] form.bk-widget');
  const formB = page.locator('[data-widget-index="1"] form.bk-widget');
  await expect(formA).toBeVisible();
  await expect(formB).toBeVisible();

  // Both instances load real availability independently.
  await expect(formA.getByRole('radiogroup').getByRole('radio').first()).toBeVisible();
  await expect(formB.getByRole('radiogroup').getByRole('radio').first()).toBeVisible();

  // Changing party size (and thus re-fetching availability) on A must not disturb B.
  await formA.getByLabel('How many people?').selectOption('3');
  await expect(formA.getByRole('button', { name: 'Continue to payment' })).toBeEnabled();
  await expect(formB.getByRole('button', { name: 'Continue to payment' })).toBeEnabled();
});
