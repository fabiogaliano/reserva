import { test, expect } from '@playwright/test';

// loadAvailability fires on every party-size change with no abort/generation check, so a stale
// response settling late could overwrite a newer party size's slots. Mocks distinguishable fake
// slots per party size so which response won is unambiguous.
test('a stale availability response cannot overwrite a newer party-size selection', async ({ page }) => {
  const from = new Date().toISOString().slice(0, 10);
  let releaseStale: () => void = () => {};
  const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });

  await page.route('**/api/booking/availability*', async (route) => {
    const url = new URL(route.request().url());
    const quantity = url.searchParams.get('quantity');
    // quantity=2's request is the one this test holds open (the "stale" one); every other party
    // size gets a distinct, immediately-resolved fake slot so the displayed time unambiguously
    // reveals which response actually won.
    const startTime = quantity === '3' ? '14:00' : '09:00';
    const body = JSON.stringify({
      days: [{
        date: from,
        status: 'open',
        slots: [{ start: `${from}T${startTime}:00.000Z`, remaining: null }],
      }],
    });
    if (quantity === '2') await staleGate;
    await route.fulfill({ status: 200, contentType: 'application/json', body });
  });

  await page.goto('/');
  // Initial load (default quantity=1, resolves immediately) has settled.
  await expect(page.locator('.bkw-slot-time').first()).toHaveText('09:00');

  // Switch to 2 (the request this test holds open) and, before it resolves, switch to 3 (resolves
  // immediately) — the exact race both belts (abort + generation) must survive.
  await page.getByLabel('How many people?').selectOption('2');
  await page.getByLabel('How many people?').selectOption('3');
  await expect(page.locator('.bkw-slot-time').first()).toHaveText('14:00');
  await expect(page.getByRole('radiogroup').getByRole('radio').first()).toBeEnabled();

  // Only now let the stale quantity=2 response through. A real fix must not let it undo what
  // quantity=3 already rendered — this is the assertion that fails against pre-change code.
  releaseStale();
  await page.waitForTimeout(500);
  await expect(page.locator('.bkw-slot-time').first()).toHaveText('14:00');
  // A superseded response reaching the finally block must not clear aria-busy out from under
  // whatever the current (quantity=3) request state left it as.
  await expect(page.locator('calendar-date')).not.toHaveAttribute('aria-busy', 'true');
});
