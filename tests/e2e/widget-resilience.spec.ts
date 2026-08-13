import { test, expect } from '@playwright/test';

// Plan 014 item B: BookingWidget.astro rendered its form `hidden` with only a <noscript> fallback,
// and `form.hidden = false` ran *before* readData(form) (a JSON.parse that can throw) inside an
// uncaught top-level loop. JavaScript enabled but blocked or throwing meant the visitor saw neither
// the form nor a contact fallback — a widget that silently vanished.

test('aborting the widget module load keeps the default fallback visible instead of a dead hidden form', async ({ page }) => {
  // JS stays "enabled" (unlike a BrowserContext with javaScriptEnabled: false) — only the specific
  // network request for this component's client script is blocked, simulating an ad blocker, a
  // strict CSP, or a flaky CDN rather than JS being off entirely.
  await page.route('**/BookingWidget.astro?astro&type=script*', (route) => route.abort());
  await page.goto('/');

  const form = page.locator('form.bk-widget');
  const fallback = page.locator('[data-bookkit-fallback]');
  await expect(fallback).toBeVisible();
  await expect(form).toBeHidden();
});

test('a corrupted data island in one instance does not stop the sibling widget from initializing', async ({ page }) => {
  // Rewrites only the first of the two-widgets fixture's two identical data islands (see
  // examples/smoke-site/src/pages/two-widgets.astro) into invalid JSON, simulating a hand-edited or
  // truncated island — the actual failure mode readData(form)'s JSON.parse can hit.
  await page.route('**/two-widgets', async (route) => {
    if (route.request().resourceType() !== 'document') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const original = await response.text();
    let seen = 0;
    const corrupted = original.replace(
      /(<script type="application\/json" data-bookkit-data>)([^<]*)(<\/script>)/g,
      (match, open: string, _json: string, close: string) => {
        seen += 1;
        return seen === 1 ? `${open}{not valid json${close}` : match;
      },
    );
    expect(seen).toBe(2); // sanity: both instances' islands were found before corrupting one
    await route.fulfill({ response, body: corrupted });
  });
  await page.goto('/two-widgets');

  const instanceA = page.locator('[data-widget-index="0"]');
  const instanceB = page.locator('[data-widget-index="1"]');

  // Instance A: corrupted data island — its own fallback stays visible, its form stays hidden.
  await expect(instanceA.locator('[data-bookkit-fallback]')).toBeVisible();
  await expect(instanceA.locator('form.bk-widget')).toBeHidden();

  // Instance B: unaffected by its sibling's failure — initializes normally and stays fully operable.
  await expect(instanceB.locator('[data-bookkit-fallback]')).toBeHidden();
  await expect(instanceB.locator('form.bk-widget')).toBeVisible();
  await expect(instanceB.getByRole('radiogroup').getByRole('radio').first()).toBeVisible();
});
