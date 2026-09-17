import { test, expect } from '@playwright/test';

// Every control is open, so an edit is visible in place; the field and the save bar say it is not
// saved yet, and nothing persists until Save is clicked.
test('editing a setting flags the field and the section as unsaved until Save', async ({ page }) => {
  await page.goto('/booking/admin?view=settings&section=policy');
  const form = page.locator('#bk-s-policy');
  const input = form.locator('input[name="booking.minNoticeHours"]');
  const field = form.locator(".bk-sfield", { has: page.locator("input[name=\"booking.minNoticeHours\"]") });
  const before = await input.inputValue();

  await expect(form.locator('.bk-unsaved')).toBeHidden();
  await expect(field.locator('.bk-sfield-dirty')).toBeHidden();
  await input.fill('24');
  await expect(field.locator('.bk-sfield-dirty')).toBeVisible();
  await expect(form.locator('.bk-unsaved')).toBeVisible();

  // Reloading without saving shows the server's value again: nothing was persisted.
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto('/booking/admin?view=settings&section=policy');
  await expect(page.locator('input[name="booking.minNoticeHours"]')).toHaveValue(before);

  await page.locator('input[name="booking.minNoticeHours"]').fill('24');
  await page.locator('#bk-s-policy').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');
  await expect(page.locator('input[name="booking.minNoticeHours"]')).toHaveValue('24');
  await expect(page.locator('#bk-s-policy').getByText('Modified').first()).toBeVisible();
});
