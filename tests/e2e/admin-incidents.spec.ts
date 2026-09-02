import { test, expect } from '@playwright/test';
import { createBooking } from './helpers';

const TOUR = 'oldTown';
// Astro's checkOrigin middleware rejects cross-site POSTs unless Origin matches — the browser sets
// this automatically for real form POSTs, but the API request context used for these dev-only
// test seams doesn't, so it needs setting explicitly.
const DEV_POST_HEADERS = { origin: 'http://localhost:4399' };

// The admin "Attention required" cards and their CSRF-protected actions, exercised through a real
// browser (not just server-rendered HTML — see tests/handlers-admin-incidents.test.ts). `astro dev`
// has no Cron Trigger, so `POST /dev/reconcile.json` stands in, calling the same runReconciliation
// a real scheduled() handler would through the same context-construction path.
test('a one-shot provider failure opens an incident, "Try again" resolves it, a separate incident requires a note to resolve manually and survives reload, an oversell card has no Retry button, and exactly one alert is delivered per revision', async ({ page, request }) => {
  // --- Seed: two bookings with a forced permanent calendar_create failure (armNextCalendarFailure),
  // plus one normal booking to seed an oversell incident directly (a real oversell race is
  // unrelated to what this test proves).
  await request.post('/dev/force-calendar-failure.json', { headers: DEV_POST_HEADERS });
  const retryTarget = await createBooking(page, { service: TOUR, quantity: 2 });
  await request.post('/dev/force-calendar-failure.json', { headers: DEV_POST_HEADERS });
  const manualTarget = await createBooking(page, { service: TOUR, quantity: 2 });
  const oversellTarget = await createBooking(page, { service: TOUR, quantity: 2 });

  const seeded = await request.post('/dev/seed-oversell-incident.json', {
    headers: DEV_POST_HEADERS,
    data: { reference: oversellTarget.reference },
  });
  if (!seeded.ok()) throw new Error(`could not seed the oversell incident: ${await seeded.text()}`);

  // --- First reconciliation pass: opens both calendar_create incidents (immediate — a permanent
  // failure classifies 'abandoned' on the first attempt, no ten-minute wait) and delivers one
  // alert per revision.
  await request.post('/dev/reconcile.json', { headers: DEV_POST_HEADERS });

  const alertsAfterFirstPass = await (await request.get('/dev/alerts.json')).json();
  const retryAlert = alertsAfterFirstPass.find((a: any) => a.reference === retryTarget.reference);
  const manualAlert = alertsAfterFirstPass.find((a: any) => a.reference === manualTarget.reference);
  const oversellAlert = alertsAfterFirstPass.find((a: any) => a.reference === oversellTarget.reference);
  expect(retryAlert, 'retry-target alert').toBeTruthy();
  expect(manualAlert, 'manual-target alert').toBeTruthy();
  expect(oversellAlert, 'oversell-target alert').toBeTruthy();
  // Exactly these seven fields, no PII (no bookingId/customer name/email).
  for (const alert of [retryAlert, manualAlert, oversellAlert]) {
    expect(Object.keys(alert).sort()).toEqual(
      ['action', 'adminUrl', 'attemptCount', 'firstDetectedAt', 'incidentId', 'reference', 'severity'].sort(),
    );
  }
  expect(retryAlert.action).toBe('calendar');
  expect(oversellAlert.action).toBe('oversell');

  // --- Second reconciliation pass, nothing changed: no duplicate alert for any of the three.
  await request.post('/dev/reconcile.json', { headers: DEV_POST_HEADERS });
  const alertsAfterSecondPass = await (await request.get('/dev/alerts.json')).json();
  expect(alertsAfterSecondPass.filter((a: any) => a.reference === retryTarget.reference)).toHaveLength(1);
  expect(alertsAfterSecondPass.filter((a: any) => a.reference === manualTarget.reference)).toHaveLength(1);
  expect(alertsAfterSecondPass.filter((a: any) => a.reference === oversellTarget.reference)).toHaveLength(1);

  // --- The admin page renders the three cards.
  await page.goto('/booking/admin');
  const pageText = await page.locator('#bk-incidents').innerText();
  // Never the internal word "abandoned" anywhere in the section.
  expect(pageText.toLowerCase()).not.toContain('abandoned');

  const retryCard = page.locator('.bk-incident-card', { hasText: retryTarget.reference });
  const manualCard = page.locator('.bk-incident-card', { hasText: manualTarget.reference });
  const oversellCard = page.locator('.bk-incident-card', { hasText: oversellTarget.reference });
  await expect(retryCard).toContainText('Calendar booking not created');
  await expect(manualCard).toContainText('Calendar booking not created');
  await expect(oversellCard).toContainText('Booking may exceed capacity');

  // Oversell: no Retry button, only the manual-handling note.
  await expect(oversellCard.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(oversellCard).toContainText('no automatic retry is available');
  await expect(oversellCard.getByRole('button', { name: 'I handled this manually' })).toBeVisible();

  // --- "Try again": the forced failure was one-shot, so the row recovers immediately, but the
  // incident itself only re-resolves on the next reconciliation pass — a second
  // /dev/reconcile.json call stands in for that next tick.
  await retryCard.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('#bk-incidents')).toContainText('Retry attempted');
  await request.post('/dev/reconcile.json', { headers: DEV_POST_HEADERS });
  await page.reload();
  await expect(page.locator('.bk-incident-card', { hasText: retryTarget.reference })).toHaveCount(0);

  // --- Manual resolution on the manual-target card: requires the note, resolves synchronously
  // (no reconciliation pass needed), records who/when, and survives a reload in history.
  const manualForm = manualCard.locator('form', { hasText: 'What did you do' });
  await manualForm.getByLabel('What did you do?').fill('Called the customer and confirmed the slot by phone.');
  await manualForm.getByRole('button', { name: 'I handled this manually' }).click();
  await expect(page.locator('#bk-incidents')).toContainText('Marked as handled');
  await expect(page.locator('.bk-incident-card', { hasText: manualTarget.reference })).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.bk-incident-card', { hasText: manualTarget.reference })).toHaveCount(0);
  await page.locator('#bk-incidents summary', { hasText: 'Recently resolved' }).click();
  const history = page.locator('.bk-incident-history');
  await expect(history).toContainText(manualTarget.reference);
  await expect(history).toContainText('Resolved manually by');
});
