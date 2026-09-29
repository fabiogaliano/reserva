import { test, expect, type Locator } from '@playwright/test';

// Values, not labels: the contract is sizes 1..maxQuantity; the labels are catalog copy.
const optionValues = (select: Locator) => select.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));

// The party-size select defaulted to [1, 2, 3, 4] for every service, whatever the service prices:
// River Cruise (maxQuantity 6) could never be booked for 5 or 6, and a service capped below 4
// offered sizes checkout would reject.

test('River Cruise offers every party size it prices, up to its catalog maxQuantity of 6', async ({ page }) => {
  await page.goto('/river-cruise');
  await expect(page.getByRole('radiogroup').getByRole('radio').first()).toBeVisible();
  const quantity = page.getByLabel('How many people?');
  await expect.poll(() => optionValues(quantity)).toEqual(['1', '2', '3', '4', '5', '6']);

  // The largest size is a real, quotable party, not just an option.
  await quantity.selectOption('6');
  await expect(page.locator('[data-reserva-price-value]')).not.toBeEmpty();
});

test('a service capped below 4 offers nothing above its cap', async ({ page }) => {
  await page.route('**/api/booking/catalog*', async (route) => {
    const response = await route.fetch();
    const catalog = await response.json();
    for (const service of catalog.services) {
      if (service.slug === 'oldTown') service.maxQuantity = 2;
    }
    await route.fulfill({ response, json: catalog });
  });
  await page.goto('/');
  await expect(page.getByRole('radiogroup').getByRole('radio').first()).toBeVisible();
  await expect.poll(() => optionValues(page.getByLabel('How many people?'))).toEqual(['1', '2']);
});
