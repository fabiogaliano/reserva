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

// Response bodies (status pages, HTML error bodies) are where PII/
// operator-visible detail rides — cap what ever reaches an Error message so a caller that logs it
// (or an upstream catch that does `String(error)`) can't leak an unbounded body into application
// logs, and expose `status` as a plain property so a caller can log it structurally instead.
//
// Extends the internal ProviderFailure base so the outbox attempt
// cap (src/confirmation.ts) can classify a Brevo failure's retryability from `.status` — this
// class's own name/`.status`/`instanceof` shape is unchanged for existing consumers.
const MAX_ERROR_BODY_CHARS = 200;
export class BrevoResponseError extends ProviderFailure {
  constructor(status: number, body: string) {
    super({ status, message: `Brevo email request failed (${status}): ${body.slice(0, MAX_ERROR_BODY_CHARS)}` });
    this.name = 'BrevoResponseError';
  }
}

// Brevo's own wire vocabulary — the transactional-email API's request-body field names, kept
// distinct from the provider-neutral `RenderedEmail` (`{ subject, html, text? }`,
// `@reservajs/astro/email`) so that shape never leaks a Brevo-specific field name into the public
// renderer seam.
export interface BrevoEmailContent { subject: string; htmlContent: string; textContent?: string }
export interface BrevoSender { email: string; name?: string }
export interface BrevoRecipientAddress { email: string; name?: string }
export interface BrevoEmailProviderOptions {
  apiKey: string; sender?: BrevoSender; owner?: BrevoRecipientAddress; endpoint?: string;
  fetch?: typeof fetch; fetchImpl?: typeof fetch;
  // The one full-replacement customization level. Speaks the
  // provider-neutral `EmailRenderer` contract from `@reservajs/astro/email`, not a Brevo-specific
  // shape, so a renderer written against this option also works unmodified with any other
  // transport, and can delegate events it doesn't want to replace to `renderDefaultEmail` instead
  // of copying it. Migrating from the removed `render` option: return `{ subject, html, text? }`
  // instead of `{ subject, htmlContent, textContent? }` — see the README's "Email templates"
  // section for the three customization levels.
  renderEmail?: EmailRenderer;
}

const ownerEvents = new Set<EmailBookingEvent>(['booking.confirmed', 'booking.cancelled_by_customer']);

// '' when the deployment turned the built-in manage page off — the
// renderer omits the button for an empty URL, so disabling `routes.manage` can't leave a 404 link
// in a customer's inbox. The APIs behind the page stay mounted; only this page is gone.
function manageUrl(config: ClientConfig, token: string, routeConfig?: ReservaResolvedRouteConfig): string {
  if (routeConfig && !routeConfig.groups.manage) return '';
  return `${config.business.url.replace(/\/$/, '')}${routeConfig?.paths.managePage ?? '/booking/manage'}?token=${encodeURIComponent(token)}`;
}

// config.emails.locale pins every email to one language (an operator whose working language
// differs from the site's customer locales); absent keeps the per-booking language.
export function emailLocaleFor(booking: Booking, config: ClientConfig): string {
  return config.emails?.locale
    ?? (config.locales.supported.includes(booking.locale) ? booking.locale : config.locales.default);
}

function localStart(booking: Booking, config: ClientConfig): string {
  return new Intl.DateTimeFormat(formatLocaleFor(emailLocaleFor(booking, config)), { dateStyle: 'medium', timeStyle: 'short', timeZone: config.business.timezone }).format(new Date(booking.startsAt));
}

// Maps the renderer's provider-neutral result onto Brevo's own wire vocabulary — the one place a
// Brevo-specific field name (htmlContent/textContent) exists, whether the renderer that produced
// it was the built-in default or a fully custom one (both now speak the same EmailRenderer shape).
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
  // Which recipients apply for an event, exposed so a caller (the mutation
  // dispatcher) can record + retry each recipient as its own durable operation without knowing
  // this provider's template config.
  recipientsForEvent(event: EmailBookingEvent): BrevoRecipient[] {
    const recipients: BrevoRecipient[] = ['customer'];
    if (ownerEvents.has(event)) recipients.push('owner');
    return recipients;
  }

  // Single-recipient send, so a caller can treat the customer and owner messages as
  // independent operations — an owner-send failure here never touches the customer's address.
  async sendToRecipient(
    recipient: BrevoRecipient,
    event: EmailBookingEvent,
    booking: Booking,
    config: ClientConfig,
    routeConfig?: ReservaResolvedRouteConfig,
  ): Promise<void> {
    const address = addressFor(recipient, booking, config, this.owner);
    if (!address) return;
    // '' rather than a dead link when the token isn't
    // presentable — the renderer omits the manage button for an empty URL. Kept here (not lost in
    // the sendToRecipient/send split) — see the isManageableToken doc comment.
    const context: EmailTemplateContext = { event, booking, config, locale: emailLocaleFor(booking, config), recipient, customerManageUrl: isManageableToken(booking.cancelToken) ? manageUrl(config, booking.cancelToken, routeConfig) : '', operatorManageUrl: isManageableToken(booking.operatorToken) ? manageUrl(config, booking.operatorToken, routeConfig) : '', startsAtLocal: localStart(booking, config) };
    const content = toBrevoContent(this.renderer(context));
    const response = await this.request(this.endpoint, { method: 'POST', headers: { accept: 'application/json', 'api-key': this.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ ...content, sender: this.sender ?? { email: config.business.contact.email, name: config.business.name }, to: [address] }) });
    if (!response.ok) throw new BrevoResponseError(response.status, await response.text());
  }

  // Kept as the whole-event send (customer then owner, sequentially, in one call) for callers
  // that don't need per-recipient tracking (e.g. the confirmation-path outbox's single
  // 'email_confirmation' operation — see src/confirmation.ts executeOperation). Implemented in
  // terms of sendToRecipient so both paths share one HTTP-call implementation.
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
