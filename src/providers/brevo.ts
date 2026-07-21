import type { Booking } from '../core/booking';
import type { ClientConfig } from '../core/config';
import type { EmailBookingEvent, EmailProvider } from '../core/events';
import type { BookkitResolvedRouteConfig } from '../routes-manifest';

export const BREVO_TRANSACTIONAL_EMAIL_URL = 'https://api.brevo.com/v3/smtp/email';
export const BREVO_API_URL = BREVO_TRANSACTIONAL_EMAIL_URL;
export type BrevoRecipient = 'customer' | 'owner';

export interface BrevoEmailContent { subject: string; htmlContent: string; textContent?: string }
export interface BrevoEmailTemplateContext {
  event: EmailBookingEvent; booking: Booking; config: ClientConfig; locale: string; recipient: BrevoRecipient;
  customerManageUrl: string; operatorManageUrl: string; startsAtLocal: string;
}
export type BrevoEmailRenderer = (context: BrevoEmailTemplateContext) => BrevoEmailContent;
export interface BrevoSender { email: string; name?: string }
export interface BrevoRecipientAddress { email: string; name?: string }
export interface BrevoEmailProviderOptions {
  apiKey: string; sender?: BrevoSender; owner?: BrevoRecipientAddress; endpoint?: string;
  fetch?: typeof fetch; fetchImpl?: typeof fetch; render?: BrevoEmailRenderer; renderEmail?: BrevoEmailRenderer;
}

type TemplateSet = Record<EmailBookingEvent, Record<BrevoRecipient, BrevoEmailContent>>;
const ownerEvents = new Set<EmailBookingEvent>(['booking.confirmed', 'booking.cancelled_by_customer']);
const english: TemplateSet = {
  'booking.confirmed': {
    customer: { subject: 'Booking confirmed — {reference}', htmlContent: '<p>Hi {customerName},</p><p>Your booking <strong>{reference}</strong> is confirmed for <strong>{startsAtLocal}</strong>.</p><p>Pickup: <strong>{pickupDetails}</strong>.</p><p>{pickupMapLink}</p><p>Contact: {contact}</p><p><a href="{customerManageUrl}">Manage your booking</a></p>' },
    owner: { subject: 'New booking — {reference}', htmlContent: '<p>A new booking was confirmed.</p><p><strong>{reference}</strong> · {customerName} · {people} people · {startsAtLocal}</p><p><a href="{operatorManageUrl}">Open operator actions</a></p>' },
  },
  'booking.cancelled_by_customer': {
    customer: { subject: 'Booking cancelled — {reference}', htmlContent: '<p>Hi {customerName},</p><p>Your booking <strong>{reference}</strong> has been cancelled.</p>' },
    owner: { subject: 'Customer cancelled — {reference}', htmlContent: '<p>The customer cancelled booking <strong>{reference}</strong>.</p><p><a href="{operatorManageUrl}">Open operator actions</a></p>' },
  },
  'booking.cancelled_by_operator': { customer: { subject: 'Booking cancelled by the operator — {reference}', htmlContent: '<p>Your booking <strong>{reference}</strong> was cancelled by the operator.</p>' }, owner: { subject: 'Booking cancelled — {reference}', htmlContent: '<p>Booking <strong>{reference}</strong> was cancelled by the operator.</p>' } },
  'booking.rescheduled': { customer: { subject: 'Booking rescheduled — {reference}', htmlContent: '<p>Your booking <strong>{reference}</strong> is now scheduled for <strong>{startsAtLocal}</strong>.</p><p><a href="{customerManageUrl}">Manage your booking</a></p>' }, owner: { subject: 'Booking rescheduled — {reference}', htmlContent: '<p>Booking <strong>{reference}</strong> is now scheduled for <strong>{startsAtLocal}</strong>.</p>' } },
  'booking.no_show': { customer: { subject: 'Booking update — {reference}', htmlContent: '<p>Booking <strong>{reference}</strong> was marked as a no-show.</p>' }, owner: { subject: 'No-show — {reference}', htmlContent: '<p>Booking <strong>{reference}</strong> was marked as a no-show.</p>' } },
  'booking.reminder': { customer: { subject: 'Reminder for your booking — {reference}', htmlContent: '<p>This is a reminder for your booking on <strong>{startsAtLocal}</strong>.</p><p><a href="{customerManageUrl}">View booking details</a></p>' }, owner: { subject: 'Booking reminder — {reference}', htmlContent: '<p>Reminder: booking <strong>{reference}</strong> starts at <strong>{startsAtLocal}</strong>.</p>' } },
  'booking.review_request': { customer: { subject: 'How was your tour? — {reference}', htmlContent: '<p>We hope you enjoyed your tour. We would love to hear your feedback.</p>' }, owner: { subject: 'Review request — {reference}', htmlContent: '<p>Booking <strong>{reference}</strong> is ready for a review request.</p>' } },
};
const portuguese: TemplateSet = {
  ...english,
  'booking.confirmed': {
    customer: { subject: 'Reserva confirmada — {reference}', htmlContent: '<p>Olá {customerName},</p><p>A sua reserva <strong>{reference}</strong> está confirmada para <strong>{startsAtLocal}</strong>.</p><p>Recolha: <strong>{pickupDetails}</strong>.</p><p>{pickupMapLink}</p><p>Contacto: {contact}</p><p><a href="{customerManageUrl}">Gerir a sua reserva</a></p>' },
    owner: { subject: 'Nova reserva — {reference}', htmlContent: '<p>Foi confirmada uma nova reserva.</p><p><strong>{reference}</strong> · {customerName} · {people} pessoas · {startsAtLocal}</p><p><a href="{operatorManageUrl}">Abrir ações do operador</a></p>' },
  },
  'booking.cancelled_by_customer': {
    customer: { subject: 'Reserva cancelada — {reference}', htmlContent: '<p>Olá {customerName},</p><p>A sua reserva <strong>{reference}</strong> foi cancelada.</p>' },
    owner: { subject: 'Cancelamento pelo cliente — {reference}', htmlContent: '<p>O cliente cancelou a reserva <strong>{reference}</strong>.</p><p><a href="{operatorManageUrl}">Abrir ações do operador</a></p>' },
  },
};
const templates: Record<string, TemplateSet> = { en: english, pt: portuguese, 'pt-BR': portuguese };

function candidates(locale: string, fallback: string): string[] {
  const values: Array<string | undefined> = [locale, locale.split('-')[0], fallback, fallback.split('-')[0], 'en'];
  return values.filter((value, index): value is string => Boolean(value) && values.indexOf(value) === index);
}
function getTemplate(event: EmailBookingEvent, recipient: BrevoRecipient, locale: string, fallback: string): BrevoEmailContent {
  for (const candidate of candidates(locale, fallback)) {
    const value = templates[candidate]?.[event]?.[recipient];
    if (value) return value;
  }
  return english[event][recipient];
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!); }
function interpolate(template: string, values: Record<string, string>): string { return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key: string) => values[key] ?? ''); }
function manageUrl(config: ClientConfig, token: string, routePaths?: BookkitResolvedRouteConfig['paths']): string { return `${config.business.url.replace(/\/$/, '')}${routePaths?.managePage ?? '/booking/manage'}?token=${encodeURIComponent(token)}`; }
function localStart(booking: Booking, config: ClientConfig): string {
  const locale = booking.locale === 'auto' ? config.locales.default : booking.locale || config.locales.default;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: config.business.timezone }).format(new Date(booking.startsAt));
}
function defaultRender(context: BrevoEmailTemplateContext): BrevoEmailContent {
  const source = getTemplate(context.event, context.recipient, context.locale, context.config.locales.default);
  const tour = context.config.tours[context.booking.tourSlug];
  const defaultPickup = tour?.meetingPoint.label ?? '';
  const pickupDetails = context.booking.pickupType === 'custom'
    ? context.booking.pickupAddress ?? 'Custom pickup address pending'
    : defaultPickup;
  const pickupMapLink = context.booking.pickupType === 'default' && tour?.meetingPoint.mapsUrl
    ? `<a href="${escapeHtml(tour.meetingPoint.mapsUrl)}">Open map</a>`
    : '';
  const contact = [context.config.business.contact.phone, context.config.business.contact.whatsapp]
    .filter(Boolean)
    .join(' · ');
  const values = {
    customerName: escapeHtml(context.booking.customerName ?? ''), reference: escapeHtml(context.booking.reference), people: String(context.booking.people),
    startsAtLocal: escapeHtml(context.startsAtLocal), pickupDetails: escapeHtml(pickupDetails), pickupMapLink, contact: escapeHtml(contact),
    customerManageUrl: context.customerManageUrl, operatorManageUrl: context.operatorManageUrl,
  };
  return { subject: interpolate(source.subject, values), htmlContent: interpolate(source.htmlContent, values), ...(source.textContent ? { textContent: interpolate(source.textContent, values) } : {}) };
}
function addressFor(recipient: BrevoRecipient, booking: Booking, config: ClientConfig, owner?: BrevoRecipientAddress): BrevoRecipientAddress | null {
  if (recipient === 'customer') return booking.customerEmail ? { email: booking.customerEmail, ...(booking.customerName ? { name: booking.customerName } : {}) } : null;
  return owner ?? { email: config.business.contact.email, name: config.business.name };
}

export class BrevoEmailProvider implements EmailProvider {
  private readonly apiKey: string; private readonly sender: BrevoSender | undefined; private readonly owner: BrevoRecipientAddress | undefined;
  private readonly endpoint: string; private readonly request: typeof fetch; private readonly renderer: BrevoEmailRenderer;
  constructor(options: BrevoEmailProviderOptions) {
    if (!options.apiKey) throw new Error('Brevo apiKey is required');
    this.apiKey = options.apiKey; this.sender = options.sender; this.owner = options.owner; this.endpoint = options.endpoint ?? BREVO_TRANSACTIONAL_EMAIL_URL;
    this.request = options.fetchImpl ?? options.fetch ?? globalThis.fetch.bind(globalThis); this.renderer = options.renderEmail ?? options.render ?? defaultRender;
  }
  async send(
    event: EmailBookingEvent,
    booking: Booking,
    config: ClientConfig,
    routePaths?: BookkitResolvedRouteConfig['paths'],
  ): Promise<void> {
    const recipients: BrevoRecipient[] = ['customer']; if (ownerEvents.has(event)) recipients.push('owner');
    for (const recipient of recipients) {
      const address = addressFor(recipient, booking, config, this.owner); if (!address) continue;
      const context: BrevoEmailTemplateContext = { event, booking, config, locale: config.locales.supported.includes(booking.locale) ? booking.locale : config.locales.default, recipient, customerManageUrl: manageUrl(config, booking.cancelToken, routePaths), operatorManageUrl: manageUrl(config, booking.operatorToken, routePaths), startsAtLocal: localStart(booking, config) };
      const content = this.renderer(context);
      const response = await this.request(this.endpoint, { method: 'POST', headers: { accept: 'application/json', 'api-key': this.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ ...content, sender: this.sender ?? { email: config.business.contact.email, name: config.business.name }, to: [address] }) });
      if (!response.ok) throw new Error(`Brevo email request failed (${response.status}): ${await response.text()}`);
    }
  }
}
export function brevoEmail(options: BrevoEmailProviderOptions): BrevoEmailProvider { return new BrevoEmailProvider(options); }
export const createBrevoEmailProvider = brevoEmail;
export function resolveBrevoLocale(locale: string, fallback: string): string { return candidates(locale, fallback)[0] ?? fallback; }
