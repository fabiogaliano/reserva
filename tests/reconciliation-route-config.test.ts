import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { emailAlertSink } from '../src/alerts/email-sink';
import { createReservaContext } from '../src/context';
import { brevoEmail } from '../src/providers/email-brevo/index';
import { scheduledHandler } from '../src/reconciliation';
import { booking, config } from './fixtures';
import { fakeRepository, providers, seedSideEffectOperation } from './fakes';

// A routePrefix reaches the runtime only through the build's virtual config; the runtime module's
// own createContext falls back to unprefixed paths, so the cron must apply the real ones itself.
vi.mock('virtual:reserva/config', async () => {
  const { resolveRouteConfig } = await import('../src/routes-manifest');
  const { config: fixtureConfig } = await import('./fixtures');
  return { default: { config: fixtureConfig, routes: resolveRouteConfig('/en') } };
});

const clock = () => new Date('2026-08-14T10:00:00.000Z');

describe('scheduledHandler with a routePrefix', () => {
  it('links cron-sent customer emails and operator alerts to the prefixed manage and admin pages', async () => {
    const retried = booking({ id: 'cron-prefix-email', startsAt: '2026-08-20T09:00:00.000Z', endsAt: '2026-08-20T10:00:00.000Z' });
    const stuck = booking({ id: 'cron-prefix-incident', reference: 'LVT-2026-002', startsAt: '2026-08-21T09:00:00.000Z', endsAt: '2026-08-21T10:00:00.000Z' });
    const repo = fakeRepository([retried, stuck]);
    seedSideEffectOperation(repo, retried.id, { family: 'email', event: 'booking.confirmed' }, {
      status: 'pending', createdAt: '2026-08-14T09:00:00.000Z', updatedAt: '2026-08-14T09:00:00.000Z',
    });
    seedSideEffectOperation(repo, stuck.id, { family: 'calendar_create' }, {
      status: 'abandoned', attemptCount: 10, error: 'calendar down',
      createdAt: '2026-08-14T09:00:00.000Z', updatedAt: '2026-08-14T09:00:00.000Z', failureStartedAt: '2026-08-14T09:00:00.000Z',
    });
    const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 201 }));
    const email = brevoEmail({ apiKey: 'key', fetchImpl: request });
    const runtime = {
      createContext: () => createReservaContext({
        config, db: {} as D1Database, repo, clock,
        providers: providers({ email, alerts: emailAlertSink(email) }),
      }),
    };

    await scheduledHandler(runtime)({} as ScheduledController, {}, {} as ExecutionContext);

    const bodies = request.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { subject: string; htmlContent: string; textContent?: string });
    const confirmation = bodies.find((body) => body.htmlContent.includes('cancel-token'));
    expect(confirmation?.htmlContent).toContain(`${config.business.url}/en/booking/manage?token=cancel-token`);
    const alert = bodies.find((body) => body.subject.includes('LVT-2026-002'));
    expect(alert?.htmlContent).toContain(`${config.business.url}/en/booking/admin?view=incidents`);
    const everything = bodies.map((body) => body.htmlContent).join('\n');
    expect(everything).not.toContain(`${config.business.url}/booking/`);
  });
});
