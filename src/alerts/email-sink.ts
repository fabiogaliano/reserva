// The one shipped OperationalAlertSink. Alerts go to the business contact by the transport the
// deployment already configured for booking mail, so an operator gets nothing new to set up. If
// email is down the incident still shows on the admin dashboard — there is deliberately no second
// channel to keep failing over to.
import virtualConfig from 'virtual:reserva/config';
import { validateConfig, type ResolvedClientConfig } from '../core/config.js';
import type { EmailProvider, OperationalAlert, OperationalAlertSink } from '../core/events.js';
import { emailString } from '../email/copy.js';
import { renderMessageEmail } from '../email/render.js';

export interface EmailAlertSinkOptions {
  // Defaults to `config.business.contact.email`; set it to route alerts to a technical mailbox
  // separate from the one customers reply to.
  to?: string;
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key: string) => values[key] ?? '');
}

export function emailAlertSink(email: EmailProvider, options: EmailAlertSinkOptions = {}): OperationalAlertSink {
  // At construction, not on the first alert: a provider without `sendMessage` is a wiring mistake
  // that must surface at startup rather than in the middle of an incident.
  if (!email.sendMessage) {
    throw new Error('emailAlertSink requires an email provider implementing sendMessage(); the shipped Brevo adapter does.');
  }
  const send = email.sendMessage.bind(email);
  // Lazy so importing this module costs nothing until a deployment actually wires it.
  let resolved: ResolvedClientConfig | undefined;
  const config = (): ResolvedClientConfig => (resolved ??= validateConfig(virtualConfig.config));

  return {
    async send(alert: OperationalAlert): Promise<void> {
      const current = config();
      const locale = current.emails?.locale ?? current.locales.default;
      const values: Record<string, string> = {
        action: alert.action,
        reference: alert.reference,
        severity: alert.severity,
        attemptCount: String(alert.attemptCount),
        firstDetectedAt: alert.firstDetectedAt,
        adminUrl: alert.adminUrl,
      };
      const rendered = renderMessageEmail(current, {
        subject: interpolate(emailString(current, locale, 'alert.subject'), values),
        leadHtml: interpolate(emailString(current, locale, 'alert.body'), values),
      });
      await send({
        to: options.to ?? current.business.contact.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text ?? rendered.subject,
      });
    },
  };
}
