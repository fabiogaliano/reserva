// The one shipped OperationalAlertSink, plus the runtime wiring that installs it by default.
// Both read `virtual:reserva/config`, so the mock below is what lets a case change locale.
import type { D1Database } from '@cloudflare/workers-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emailAlertSink } from '../src/alerts/email-sink';
import type { ResolvedClientConfig } from '../src/core/config';
import type { EmailMessage, EmailProvider, OperationalAlert, OperationalAlertSink } from '../src/core/events';
import { defineReservaRuntime } from '../src/runtime-context';
import { config as baseConfig } from './fixtures';

// A getter, not a frozen object: the sink reads the virtual config on its first alert.
const virtual = vi.hoisted(() => ({ config: undefined as unknown as ResolvedClientConfig }));
vi.mock('virtual:reserva/config', async () => {
  const { resolveRouteConfig } = await import('../src/routes-manifest');
  const routes = resolveRouteConfig();
  return { default: { get config() { return virtual.config; }, routes } };
});

beforeEach(() => {
  virtual.config = baseConfig;
});

const alert: OperationalAlert = {
  incidentId: 'inc_1',
  reference: 'LVT-2026-001',
  action: 'refund',
  severity: 'action_required',
  attemptCount: 3,
  firstDetectedAt: '2026-06-14T08:00:00.000Z',
  adminUrl: 'https://example.test/booking/admin',
};

function capturingEmail(): EmailProvider & { messages: EmailMessage[] } {
  const messages: EmailMessage[] = [];
  return {
    messages,
    send: async () => undefined,
    sendMessage: async (message) => { messages.push(message); },
  };
}

describe('emailAlertSink', () => {
  it('refuses a provider that cannot send a standalone message, at construction rather than mid-incident', () => {
    const emailOnlyProvider: EmailProvider = { send: async () => undefined };
    expect(() => emailAlertSink(emailOnlyProvider)).toThrow(/sendMessage/);
  });

  it('mails the business contact a message naming the incident, with both an HTML and a text body', async () => {
    const email = capturingEmail();

    await emailAlertSink(email).send(alert);

    expect(email.messages).toHaveLength(1);
    const message = email.messages[0]!;
    expect(message.to).toBe(baseConfig.business.contact.email);
    expect(message.subject).toContain('LVT-2026-001');
    expect(message.subject).toContain('refund');
    // Both bodies carry the incident detail an operator acts on — a text-only client must not get
    // an empty mail, and the admin link is the whole call to action.
    expect(message.html).toContain('https://example.test/booking/admin');
    expect(message.html).toContain('LVT-2026-001');
    expect(message.text).toContain('LVT-2026-001');
    expect(message.text).toContain('3');
  });

  it('routes alerts to an override address, leaving the customer-facing contact alone', async () => {
    const email = capturingEmail();

    await emailAlertSink(email, { to: 'ops@example.test' }).send(alert);

    expect(email.messages[0]?.to).toBe('ops@example.test');
  });

  it('renders the alert in the pinned email locale (config.emails.locale)', async () => {
    virtual.config = { ...baseConfig, emails: { locale: 'pt-PT' } };
    const email = capturingEmail();

    await emailAlertSink(email).send(alert);

    expect(email.messages[0]?.subject).toContain('Atenção necessária');
    expect(email.messages[0]?.text).toContain('precisa de atenção');
  });

  it('falls back to the deployment default locale when no email locale is pinned', async () => {
    virtual.config = { ...baseConfig, locales: { supported: ['pt-PT', 'en'], default: 'pt-PT' } };
    const email = capturingEmail();

    await emailAlertSink(email).send(alert);

    expect(email.messages[0]?.subject).toContain('Atenção necessária');
  });
});

// A deployment that already has a capable email transport gets alerts without opting in — they are
// the backstop behind the admin dashboard's "Attention required" cards.
describe('defineReservaRuntime alert-sink wiring', () => {
  const payments = {
    createCheckout: async () => ({ url: 'https://checkout.test', sessionRef: 'cs_test' }),
    parseWebhook: async () => ({ id: 'evt_test', type: 'unknown' as const }),
    getSession: async () => ({ status: 'open' as const }),
    refund: async () => ({ refundRef: 're_test', amountMinor: 0 }),
  };

  function contextFor(providerOverrides: { email?: EmailProvider; alerts?: OperationalAlertSink }) {
    const runtime = defineReservaRuntime({
      createContext: () => ({
        config: baseConfig,
        db: {} as D1Database,
        repo: {} as never,
        providers: { payments, ...providerOverrides },
      }),
    });
    return runtime.createContext({ request: new Request('https://example.test/') });
  }

  it('wires the email sink when no alerts provider is configured', async () => {
    const email = capturingEmail();

    const context = await contextFor({ email });
    await context.providers.alerts?.send(alert);

    expect(email.messages).toHaveLength(1);
    expect(email.messages[0]?.to).toBe(baseConfig.business.contact.email);
  });

  it('leaves an explicitly configured alerts provider untouched', async () => {
    const email = capturingEmail();
    const delivered: OperationalAlert[] = [];
    const explicit: OperationalAlertSink = { send: async (incident) => { delivered.push(incident); } };

    const context = await contextFor({ email, alerts: explicit });
    await context.providers.alerts?.send(alert);

    expect(delivered).toEqual([alert]);
    expect(email.messages).toEqual([]);
  });

  it('falls back to the logger when the email transport cannot send a standalone message', async () => {
    const context = await contextFor({ email: { send: async () => undefined } });

    // The cron must still run: a deployment without email gets its alerts in the Worker logs.
    expect(context.providers.alerts).toBeDefined();
    await expect(context.providers.alerts!.send(alert)).resolves.toBeUndefined();
  });
});
