import { test, expect } from '@playwright/test';

// Every control is open, so an edit is visible in place; the field and the save bar say it is not
// saved yet, Discard puts the loaded value back, and nothing persists until Save is clicked.
test('editing a setting flags the field and the section as unsaved until Save', async ({ page }) => {
  await page.goto('/booking/admin?view=settings&section=policy');
  const form = page.locator('#bk-s-policy');
  const input = form.locator('input[name="booking.minNoticeHours"]');
  const field = form.locator(".bk-sfield", { has: page.locator("input[name=\"booking.minNoticeHours\"]") });
  const before = await input.inputValue();

  const bar = form.locator('.bk-savebar');
  // The bar stays in view while a long section scrolls under it.
  await expect(bar).toHaveCSS('position', 'sticky');
  const save = bar.getByRole('button', { name: 'Save' });
  const discard = bar.getByRole('button', { name: 'Discard' });
  await expect(bar).not.toHaveAttribute('data-dirty');
  await expect(save).toBeDisabled();
  await expect(discard).toBeHidden();
  await expect(field.locator('.bk-sfield-dirty')).toBeHidden();
  await input.fill('24');
  await expect(field.locator('.bk-sfield-dirty')).toBeVisible();
  await expect(bar).toHaveAttribute('data-dirty', '');
  await expect(bar.locator('[data-reserva-savebar-msg]')).toHaveText('1 unsaved change');
  await expect(save).toBeEnabled();

  await discard.click();
  await expect(input).toHaveValue(before);
  await expect(field.locator('.bk-sfield-dirty')).toBeHidden();
  await expect(bar).not.toHaveAttribute('data-dirty');
  await expect(save).toBeDisabled();
  await input.fill('24');

  // Leaving with an unsaved edit asks first; reloading past it shows the server's value again:
  // nothing was persisted.
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => { dialogs.push(dialog.type()); void dialog.accept(); });
  await page.goto('/booking/admin?view=settings&section=policy');
  expect(dialogs).toEqual(['beforeunload']);
  await expect(page.locator('input[name="booking.minNoticeHours"]')).toHaveValue(before);

  await page.locator('input[name="booking.minNoticeHours"]').fill('24');
  await page.locator('#bk-s-policy').getByRole('button', { name: 'Save' }).click();
  // The save bar's own message is a status region too, so name the confirmation by its alert.
  await expect(page.locator('.bk-alert--ok[role="status"]')).toContainText('Saved');
  await expect(page.locator('input[name="booking.minNoticeHours"]')).toHaveValue('24');
  await expect(page.locator('#bk-s-policy').getByText('Modified').first()).toBeVisible();

  // The specs share one database: a 24-hour notice left behind closes today (and, late in the UTC
  // day, all of tomorrow) for every later spec, which then fight over the few days still open.
  await page.locator('#bk-s-policy button[value="settings-reset:booking.minNoticeHours"]').click();
  await expect(page.locator('input[name="booking.minNoticeHours"]')).toHaveValue(before);
});

// Recent changes is a navigating link, not an in-page tab, so switching sections in place from it
// must still move aria-current off it — otherwise two links claim to be the current section.
test('switching sections in place from Recent changes leaves exactly one current link', async ({ page }) => {
  await page.goto('/booking/admin?view=settings&section=history');
  const nav = page.locator('.bk-snav');
  await expect(nav.locator('a[aria-current="page"]')).toHaveAttribute('href', /section=history/);

  await nav.locator('a[data-reserva-tab="policy"]').click();
  await expect(page.locator('#bk-s-policy')).toBeVisible();
  // The side list and the narrow-screen tab bar each carry one current section link.
  const currentSection = page.locator('a[href*="section="][aria-current="page"]');
  await expect(currentSection).toHaveCount(2);
  for (const current of await currentSection.all()) {
    await expect(current).toHaveAttribute('data-reserva-tab', 'policy');
  }
});
