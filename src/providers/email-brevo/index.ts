import type { Booking } from '../../core/booking.js';
import type { ClientConfig } from '../../core/config.js';
import type { EmailBookingEvent, EmailProvider, EmailRecipientRole } from '../../core/events.js';
import { renderDefaultEmail, type EmailRenderer, type EmailTemplateContext, type RenderedEmail } from '../../email/index.js';
import { formatLocaleFor } from '../../email/render.js';
import { ProviderFailure } from '../../provider-failure.js';
import { isManageableToken } from '../../repo.js';
import type { ReservaResolvedRouteConfig } from '../../routes-manifest.js';

export const BREVO_TRANSACTIONAL_EMAIL_URL = 'https://api.brevo.com/v3/smtp/email';
export type BrevoRecipient = EmailRecipientRole;

// Caps the response body in the Error message so a `String(error)` catch-all can't leak an
// unbounded body into logs. `status` stays a plain property so ProviderFailure retry checks work.
const MAX_ERROR_BODY_CHARS = 200;
export class BrevoResponseError extends ProviderFailure {
  constructor(status: number, body: string) {
    super({ status, message: `Brevo email request failed (${status}): ${body.slice(0, MAX_ERROR_BODY_CHARS)}` });
    this.name = 'BrevoResponseError';
  }
}

// Brevo's own field names, kept distinct from the provider-neutral `RenderedEmail` so a
// Brevo-specific field name never leaks into the public renderer seam.
export interface BrevoEmailContent { subject: string; htmlContent: string; textContent?: string }
export interface BrevoSender { email: string; name?: string }
export interface BrevoRecipientAddress { email: string; name?: string }
export interface BrevoEmailProviderOptions {
  apiKey: string; sender?: BrevoSender; owner?: BrevoRecipientAddress; endpoint?: string;
  fetch?: typeof fetch; fetchImpl?: typeof fetch;
  // Speaks the provider-neutral `EmailRenderer` contract, not a Brevo-specific shape, so a
  // renderer written against this option also works unmodified with any other transport.
  renderEmail?: EmailRenderer;
}

const ownerEvents = new Set<EmailBookingEvent>(['booking.confirmed', 'booking.cancelled_by_customer']);

// Returns '' when `routes.manage` is disabled — the renderer omits the button for an empty
// URL, so a disabled manage page can't leave a 404 link in a customer's inbox.
function manageUrl(config: ClientConfig, token: string, routeConfig?: ReservaResolvedRouteConfig): string {
  if (routeConfig && !routeConfig.groups.manage) return '';
  return `${config.business.url.replace(/\/$/, '')}${routeConfig?.paths.managePage ?? '/booking/manage'}?token=${encodeURIComponent(token)}`;
}

// config.emails.locale pins every email to one language, for an operator whose working
// language differs from the site's customer locales; absent keeps the per-booking language.
export function emailLocaleFor(booking: Booking, config: ClientConfig): string {
  return config.emails?.locale
    ?? (config.locales.supported.includes(booking.locale) ? booking.locale : config.locales.default);
}

function localStart(booking: Booking, config: ClientConfig): string {
  return new Intl.DateTimeFormat(formatLocaleFor(emailLocaleFor(booking, config)), { dateStyle: 'medium', timeStyle: 'short', timeZone: config.business.timezone }).format(new Date(booking.startsAt));
}

// The one place a Brevo-specific field name (htmlContent/textContent) exists, regardless of
// whether the renderer that produced the result was the built-in default or a custom one.
function toBrevoContent(rendered: RenderedEmail): BrevoEmailContent {
  return { subject: rendered.subject, htmlContent: rendered.html, ...(rendered.text !== undefined ? { textContent: rendered.text } : {}) };
}

function addressFor(recipient: BrevoRecipient, booking: Booking, config: ClientConfig, owner?: BrevoRecipientAddress): BrevoRecipientAddress | null {
  if (recipient === 'customer') return booking.customerEmail ? { email: booking.customerEmail, ...(booking.customerName ? { name: booking.customerName } : {}) } : null;
  return owner ?? { email: config.business.contact.email, name: config.business.name };
}

export class BrevoEmailProvider implements EmailProvider {
  private readonly apiKey: string; private readonly sender: BrevoSender | undefined; private readonly owner: BrevoRecipientAddress | undefined;
  private readonly endpoint: string; private readonly request: typeof fetch; private readonly renderer: EmailRenderer;
  constructor(options: BrevoEmailProviderOptions) {
    if (!options.apiKey) throw new Error('Brevo apiKey is required');
    this.apiKey = options.apiKey; this.sender = options.sender; this.owner = options.owner; this.endpoint = options.endpoint ?? BREVO_TRANSACTIONAL_EMAIL_URL;
    this.request = options.fetchImpl ?? options.fetch ?? globalThis.fetch.bind(globalThis); this.renderer = options.renderEmail ?? renderDefaultEmail;
  }
  // Exposed so a caller can record and retry each recipient as its own durable operation
  // without knowing this provider's template config.
  recipientsForEvent(event: EmailBookingEvent): BrevoRecipient[] {
    const recipients: BrevoRecipient[] = ['customer'];
    if (ownerEvents.has(event)) recipients.push('owner');
    return recipients;
  }

  // Lets a caller treat the customer and owner messages as independent operations — an
  // owner-send failure here never touches the customer's address.
  async sendToRecipient(
    recipient: BrevoRecipient,
    event: EmailBookingEvent,
    booking: Booking,
    config: ClientConfig,
    routeConfig?: ReservaResolvedRouteConfig,
  ): Promise<void> {
    const address = addressFor(recipient, booking, config, this.owner);
    if (!address) return;
    const context: EmailTemplateContext = { event, booking, config, locale: emailLocaleFor(booking, config), recipient, customerManageUrl: isManageableToken(booking.cancelToken) ? manageUrl(config, booking.cancelToken, routeConfig) : '', operatorManageUrl: isManageableToken(booking.operatorToken) ? manageUrl(config, booking.operatorToken, routeConfig) : '', startsAtLocal: localStart(booking, config) };
    const content = toBrevoContent(this.renderer(context));
    const response = await this.request(this.endpoint, { method: 'POST', headers: { accept: 'application/json', 'api-key': this.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ ...content, sender: this.sender ?? { email: config.business.contact.email, name: config.business.name }, to: [address] }) });
    if (!response.ok) throw new BrevoResponseError(response.status, await response.text());
  }

  // Whole-event send (customer then owner, sequentially) for callers that don't need
  // per-recipient tracking. Built on sendToRecipient so both paths share one HTTP call.
  async send(
    event: EmailBookingEvent,
    booking: Booking,
    config: ClientConfig,
    routeConfig?: ReservaResolvedRouteConfig,
  ): Promise<void> {
    for (const recipient of this.recipientsForEvent(event)) {
      await this.sendToRecipient(recipient, event, booking, config, routeConfig);
    }
  }
}
export function brevoEmail(options: BrevoEmailProviderOptions): BrevoEmailProvider { return new BrevoEmailProvider(options); }
