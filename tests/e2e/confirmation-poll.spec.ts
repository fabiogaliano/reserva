import { test, expect } from '@playwright/test';
import { resolveRouteConfig } from '../../src/routes-manifest';
import { confirmationPage } from '../../src/ui/pages/confirmation-page';
import { config } from '../fixtures';

// The smoke site's dev payment provider completes every session it created, so a real pending
// confirmation page is unreachable end to end. The page is rendered by the real renderer and served
// in place of the route; the enhancer comes from the running server's own asset route, and the
// status API is scripted — which is exactly the seam the poller talks through.
test('the pending page polls the status API in place of the meta refresh and reloads once the booking settles', async ({ page, baseURL }) => {
  const context = { config, routeConfig: resolveRouteConfig() };
  const pageUrl = `${baseURL}/booking-confirmation?sessionId=cs_poll`;
  const documents: string[] = [];
  let settled = false;
  await page.route('**/booking-confirmation?**', async (route) => {
    documents.push(route.request().url());
    const html = settled
      ? confirmationPage(context, { status: 'expired', booking: null }, route.request().url(), null)
      : confirmationPage(context, { status: 'pending', booking: null }, route.request().url(), null);
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  });
  let polls = 0;
  await page.route('**/api/booking/status?**', async (route) => {
    polls += 1;
    expect(new URL(route.request().url()).searchParams.get('sessionId')).toBe('cs_poll');
    // One server hiccup, one plain pending, then the booking settles.
    if (polls === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"internal_error","message":"x"}}' });
    if (polls === 2) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"pending","booking":null}' });
    settled = true;
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"expired","booking":null}' });
  });

  await page.goto(pageUrl);
  await expect(page.locator('h1')).toContainText('Confirming your payment');
  await expect(page.locator('[data-reserva-poll-live]')).toHaveText('Still checking with the payment provider…', { timeout: 10_000 });
  await expect(page.locator('h1')).toContainText('Checkout expired', { timeout: 15_000 });

  expect(polls).toBe(3);
  // One load, then the single navigation the poller made itself: the meta refresh never fired.
  expect(documents).toHaveLength(2);
  expect(new URL(documents[1]!).searchParams.get('attempt')).toBe('0');
});
