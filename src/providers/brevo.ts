import type { Booking } from '../core/booking';
import { meetingPointForBooking, pickupOptionFor, type ClientConfig } from '../core/config';
import type { EmailBookingEvent, EmailProvider, EmailRecipientRole } from '../core/events';
import { ProviderFailure } from '../provider-failure';
import type { BookkitResolvedRouteConfig } from '../routes-manifest';

export const BREVO_TRANSACTIONAL_EMAIL_URL = 'https://api.brevo.com/v3/smtp/email';
export const BREVO_API_URL = BREVO_TRANSACTIONAL_EMAIL_URL;
export type BrevoRecipient = EmailRecipientRole;

// BK-SIDE-001 (handoff 13): response bodies (status pages, HTML error bodies) are where PII/
// operator-visible detail rides — cap what ever reaches an Error message so a caller that logs it
// (or an upstream catch that does `String(error)`) can't leak an unbounded body into application
// logs, and expose `status` as a plain property so a caller can log it structurally instead.
//
// Plan 016 (design decision 2): extends the internal ProviderFailure base so the outbox attempt
// cap (src/confirmation.ts) can classify a Brevo failure's retryability from `.status` — this
// class's own name/`.status`/`instanceof` shape is unchanged for existing consumers.
const MAX_ERROR_BODY_CHARS = 200;
export class BrevoResponseError extends ProviderFailure {
  constructor(status: number, body: string) {
    super({ status, message: `Brevo email request failed (${status}): ${body.slice(0, MAX_ERROR_BODY_CHARS)}` });
    this.name = 'BrevoResponseError';
  }
}

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

const ownerEvents = new Set<EmailBookingEvent>(['booking.confirmed', 'booking.cancelled_by_customer']);

// ---------------------------------------------------------------------------
// Copy catalogs. Flat keys so a client can override any string per locale via
// config.emails.messages — the same merge pattern ui.messages uses for widget
// copy. {placeholders} interpolate with HTML-escaped values in htmlContent and
// raw values in subject/textContent.
// ---------------------------------------------------------------------------
const eventCopyKey: Record<EmailBookingEvent, string> = {
  'booking.confirmed': 'confirmed',
  'booking.cancelled_by_customer': 'cancelledByCustomer',
  'booking.cancelled_by_operator': 'cancelledByOperator',
  'booking.rescheduled': 'rescheduled',
  'booking.no_show': 'noShow',
};

const englishEmailCopy: Record<string, string> = {
  'greeting.named': 'Hi {customerName},',
  'greeting.anonymous': 'Hello,',
  'word.guest': 'guest',
  'word.guests': 'guests',
  'label.date': 'Date',
  'label.time': 'Time',
  'label.guests': 'Guests',
  'label.meetingPoint': 'Meeting point',
  'label.pickup': 'Pickup',
  'label.openMap': 'Open map',
  'label.paid': 'Paid',
  'label.email': 'Email',
  'label.phone': 'Phone',
  'label.whatsapp': 'WhatsApp',
  'label.bookingId': 'Booking ID',
  'pickup.pending': 'Custom pickup address pending',
  'contact.lead.whatsapp': 'Questions? Just reply to this email, or call / WhatsApp us:',
  'contact.lead.plain': 'Questions? Just reply to this email, or call us:',
  'confirmed.customer.subject': 'Booking confirmed: {tourTitle} — {when}',
  'confirmed.customer.lead': "Your <strong>{tourTitle}</strong> is confirmed — we can't wait to show you around!",
  'confirmed.customer.button': 'Manage my booking',
  'confirmed.owner.subject': 'New booking: {tourTitle} — {when} · {people} {guestsWord}',
  'confirmed.owner.lead': '<strong>{customerName}</strong> booked <strong>{tourTitle}</strong>.',
  'owner.button': 'Open booking actions',
  'cancelledByCustomer.customer.subject': 'Booking cancelled: {tourTitle} — {when}',
  'cancelledByCustomer.customer.lead': 'Your <strong>{tourTitle}</strong> on {when} has been cancelled. If a refund applies, it will reach your account within 5–10 business days.',
  'cancelledByCustomer.owner.subject': 'Customer cancelled: {tourTitle} — {when}',
  'cancelledByCustomer.owner.lead': '<strong>{customerName}</strong> cancelled <strong>{tourTitle}</strong>.',
  'cancelledByOperator.customer.subject': 'Your booking was cancelled: {tourTitle} — {when}',
  'cancelledByOperator.customer.lead': "We're sorry — your <strong>{tourTitle}</strong> on {when} had to be cancelled. Any payment will be fully refunded within 5–10 business days.",
  'cancelledByOperator.owner.subject': 'Booking cancelled: {tourTitle} — {when}',
  'cancelledByOperator.owner.lead': 'Booking <strong>{reference}</strong> was cancelled by the operator.',
  'rescheduled.customer.subject': 'Booking rescheduled: {tourTitle} — {when}',
  'rescheduled.customer.lead': 'Your <strong>{tourTitle}</strong> has a new date.',
  'rescheduled.customer.button': 'Manage my booking',
  'rescheduled.owner.subject': 'Booking rescheduled: {tourTitle} — {when}',
  'rescheduled.owner.lead': 'Booking <strong>{reference}</strong> is now scheduled for {when}.',
  'noShow.customer.subject': 'Booking update: {tourTitle} — {when}',
  'noShow.customer.lead': 'Your booking for <strong>{tourTitle}</strong> on {when} was marked as a no-show. If you think this is a mistake, just reply to this email.',
  'noShow.owner.subject': 'No-show: {tourTitle} — {when}',
  'noShow.owner.lead': 'Booking <strong>{reference}</strong> was marked as a no-show.',
};

const portuguesePortugalEmailCopy: Record<string, string> = {
  'greeting.named': 'Olá {customerName},',
  'greeting.anonymous': 'Olá,',
  'word.guest': 'pessoa',
  'word.guests': 'pessoas',
  'label.date': 'Data',
  'label.time': 'Hora',
  'label.guests': 'Pessoas',
  'label.meetingPoint': 'Ponto de encontro',
  'label.pickup': 'Recolha',
  'label.openMap': 'Abrir mapa',
  'label.paid': 'Pago',
  'label.email': 'Email',
  'label.phone': 'Telefone',
  'label.whatsapp': 'WhatsApp',
  'label.bookingId': 'Referência',
  'pickup.pending': 'Endereço de recolha a confirmar',
  'contact.lead.whatsapp': 'Dúvidas? Responda a este email, ou contacte-nos por telefone / WhatsApp:',
  'contact.lead.plain': 'Dúvidas? Responda a este email, ou ligue-nos:',
  'confirmed.customer.subject': 'Reserva confirmada: {tourTitle} — {when}',
  'confirmed.customer.lead': 'A sua reserva de <strong>{tourTitle}</strong> está confirmada — mal podemos esperar por si!',
  'confirmed.customer.button': 'Gerir a minha reserva',
  'confirmed.owner.subject': 'Nova reserva: {tourTitle} — {when} · {people} {guestsWord}',
  'confirmed.owner.lead': '<strong>{customerName}</strong> reservou <strong>{tourTitle}</strong>.',
  'owner.button': 'Abrir ações da reserva',
  'cancelledByCustomer.customer.subject': 'Reserva cancelada: {tourTitle} — {when}',
  'cancelledByCustomer.customer.lead': 'A sua reserva de <strong>{tourTitle}</strong> para {when} foi cancelada. Se houver lugar a reembolso, será creditado na sua conta em 5–10 dias úteis.',
  'cancelledByCustomer.owner.subject': 'Cancelamento pelo cliente: {tourTitle} — {when}',
  'cancelledByCustomer.owner.lead': '<strong>{customerName}</strong> cancelou <strong>{tourTitle}</strong>.',
  'cancelledByOperator.customer.subject': 'A sua reserva foi cancelada: {tourTitle} — {when}',
  'cancelledByOperator.customer.lead': 'Lamentamos — a sua reserva de <strong>{tourTitle}</strong> para {when} teve de ser cancelada. Qualquer pagamento será totalmente reembolsado em 5–10 dias úteis.',
  'cancelledByOperator.owner.subject': 'Reserva cancelada: {tourTitle} — {when}',
  'cancelledByOperator.owner.lead': 'A reserva <strong>{reference}</strong> foi cancelada pelo operador.',
  'rescheduled.customer.subject': 'Reserva alterada: {tourTitle} — {when}',
  'rescheduled.customer.lead': 'A sua reserva de <strong>{tourTitle}</strong> tem uma nova data.',
  'rescheduled.customer.button': 'Gerir a minha reserva',
  'rescheduled.owner.subject': 'Reserva alterada: {tourTitle} — {when}',
  'rescheduled.owner.lead': 'A reserva <strong>{reference}</strong> está agora marcada para {when}.',
  'noShow.customer.subject': 'Atualização da reserva: {tourTitle} — {when}',
  'noShow.customer.lead': 'A sua reserva de <strong>{tourTitle}</strong> para {when} foi marcada como não comparecimento. Se acha que se trata de um erro, responda a este email.',
  'noShow.owner.subject': 'Não comparecimento: {tourTitle} — {when}',
  'noShow.owner.lead': 'A reserva <strong>{reference}</strong> foi marcada como não comparecimento.',
};

const emailCopyCatalogs: Record<string, Record<string, string>> = {
  en: englishEmailCopy, pt: portuguesePortugalEmailCopy, 'pt-PT': portuguesePortugalEmailCopy,
};

function candidates(locale: string, fallback: string): string[] {
  const values: Array<string | undefined> = [locale, locale.split('-')[0], fallback, fallback.split('-')[0], 'en'];
  return values.filter((value, index): value is string => Boolean(value) && values.indexOf(value) === index);
}

function emailString(config: ClientConfig, locale: string, key: string): string {
  for (const candidate of candidates(locale, config.locales.default)) {
    const override = config.emails?.messages?.[candidate]?.[key];
    if (override) return override;
  }
  for (const candidate of candidates(locale, config.locales.default)) {
    const value = emailCopyCatalogs[candidate]?.[key];
    if (value) return value;
  }
  return englishEmailCopy[key] ?? key;
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!); }
function interpolate(template: string, values: Record<string, string>): string { return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key: string) => values[key] ?? ''); }
function stripTags(html: string): string { return html.replace(/<[^>]+>/g, ''); }
function manageUrl(config: ClientConfig, token: string, routePaths?: BookkitResolvedRouteConfig['paths']): string { return `${config.business.url.replace(/\/$/, '')}${routePaths?.managePage ?? '/booking/manage'}?token=${encodeURIComponent(token)}`; }
// BK-SEC-002 (patch-11-r1 LOW 1): a `nohash:`-prefixed value (src/repo.ts placeholderToken) is
// what a DB-loaded Booking.cancelToken/operatorToken looks like when the row has no decryptable
// cancel_token_enc/operator_token_enc — either BOOKKIT_TOKEN_ENC_KEY isn't configured, or the row
// predates that secret being set. A link built from it would 403 the instant it's clicked; better
// to omit the link entirely than render one that looks live but is already dead.
export function isManageableToken(token: string): boolean { return !token.startsWith('nohash:'); }

// config.emails.locale pins every email to one language (an operator whose working language
// differs from the site's customer locales); absent keeps the per-booking language.
export function emailLocaleFor(booking: Booking, config: ClientConfig): string {
  return config.emails?.locale
    ?? (config.locales.supported.includes(booking.locale) ? booking.locale : config.locales.default);
}

// Bare 'en' resolves to en-US date ordering (Oct 15); European operators expect 15 Oct, so
// formatting (not copy) upgrades it to en-GB.
function formatLocaleFor(locale: string): string { return locale === 'en' ? 'en-GB' : locale; }

function localStart(booking: Booking, config: ClientConfig): string {
  return new Intl.DateTimeFormat(formatLocaleFor(emailLocaleFor(booking, config)), { dateStyle: 'medium', timeStyle: 'short', timeZone: config.business.timezone }).format(new Date(booking.startsAt));
}

interface EmailCardRow { label: string; valueHtml: string; valueText: string }
interface EmailModel {
  subject: string;
  greetingHtml?: string;
  leadHtml: string;
  card: EmailCardRow[];
  button: { label: string; url: string } | null;
  buttonInverted: boolean;
  contact: { lead: string; phones: string[]; whatsappLine: string | null } | null;
  footerHtml?: string;
}

const NEUTRAL_BRANDING = {
  logoUrl: undefined as string | undefined, logoWidth: 200, logoHeight: 28,
  headerBackground: '#1a1a1a', accentColor: '#e0b64a', cardBackground: '#f7f7f5',
};

function resolvedBranding(config: ClientConfig): typeof NEUTRAL_BRANDING {
  return { ...NEUTRAL_BRANDING, ...config.emails?.branding };
}

function digitsOf(value: string): string { return value.replace(/\D/g, ''); }

function buildModel(context: BrevoEmailTemplateContext): EmailModel {
  const { event, booking, config, locale, recipient } = context;
  const copy = (key: string) => emailString(config, locale, key);
  const eventKey = eventCopyKey[event];
  const tour = config.tours[booking.tourSlug];
  const tourTitle = tour?.title ?? booking.tourSlug;
  const formatLocale = formatLocaleFor(locale);
  const timeZone = config.business.timezone;
  const startsAt = new Date(booking.startsAt);
  const time = new Intl.DateTimeFormat(formatLocale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(startsAt);
  const when = `${new Intl.DateTimeFormat(formatLocale, { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(startsAt)}, ${time}`;
  const dateLong = new Intl.DateTimeFormat(formatLocale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone }).format(startsAt);
  const guestsWord = copy(booking.people === 1 ? 'word.guest' : 'word.guests');
  const customerName = booking.customerName ?? '';

  const rawValues: Record<string, string> = {
    tourTitle, when, customerName, reference: booking.reference,
    people: String(booking.people), guestsWord, startsAtLocal: context.startsAtLocal,
  };
  const htmlValues = Object.fromEntries(Object.entries(rawValues).map(([key, value]) => [key, escapeHtml(value)]));

  // Plan 017 (design decision 4/7): per-booking meeting-point resolution — a removed id falls back
  // to the booking's stored label snapshot with no maps link. Plan 018 (design decision 8): the
  // requiresAddress/usesMeetingPoint gates are independent, so an option declaring both renders
  // both the collected address and the meeting-point row.
  const resolvedPoint = tour ? meetingPointForBooking(tour, booking.meetingPointId ?? null, booking.meetingPointLabel ?? null) : null;
  const option = tour ? pickupOptionFor(tour, booking.pickupType) : undefined;
  const requiresAddress = option ? option.requiresAddress : booking.pickupType === 'custom';
  const usesMeetingPoint = option ? option.usesMeetingPoint : booking.pickupType === 'default';

  const pickupRows: EmailCardRow[] = [];
  if (requiresAddress) {
    const address = booking.pickupAddress ?? copy('pickup.pending');
    pickupRows.push({ label: copy('label.pickup'), valueHtml: `<strong>${escapeHtml(address)}</strong>`, valueText: address });
  }
  if (usesMeetingPoint && resolvedPoint) {
    const mapHtml = resolvedPoint.mapsUrl
      ? `<br><a href="${escapeHtml(resolvedPoint.mapsUrl)}" style="color:#b8860b;font-weight:400;font-size:14px;">${escapeHtml(copy('label.openMap'))} &nearr;</a>`
      : '';
    pickupRows.push({
      label: copy('label.meetingPoint'),
      valueHtml: `<strong>${escapeHtml(resolvedPoint.label)}</strong>${mapHtml}`,
      valueText: resolvedPoint.mapsUrl ? `${resolvedPoint.label} — ${resolvedPoint.mapsUrl}` : resolvedPoint.label,
    });
  }

  const subject = interpolate(copy(`${eventKey}.${recipient}.subject`), rawValues);
  const leadHtml = `<p style="margin:0 0 26px;font-size:17px;line-height:1.5;">${interpolate(copy(`${eventKey}.${recipient}.lead`), htmlValues)}</p>`;

  if (recipient === 'owner') {
    const price = new Intl.NumberFormat(formatLocale, { style: 'currency', currency: config.business.currency.toUpperCase() }).format(booking.priceCents / 100);
    const card: EmailCardRow[] = [
      { label: copy('label.date'), valueHtml: `<strong>${escapeHtml(`${dateLong}, ${time}`)}</strong>`, valueText: `${dateLong}, ${time}` },
      { label: copy('label.guests'), valueHtml: `<strong>${booking.people}</strong>`, valueText: String(booking.people) },
      { label: copy('label.paid'), valueHtml: `<strong>${escapeHtml(price)}</strong>`, valueText: price },
      ...pickupRows,
      ...(booking.customerEmail ? [{ label: copy('label.email'), valueHtml: `<a href="mailto:${escapeHtml(booking.customerEmail)}" style="color:inherit;">${escapeHtml(booking.customerEmail)}</a>`, valueText: booking.customerEmail }] : []),
      ...(booking.customerPhone ? [{ label: copy('label.phone'), valueHtml: `<strong>${escapeHtml(booking.customerPhone)}</strong>`, valueText: booking.customerPhone }] : []),
      { label: copy('label.bookingId'), valueHtml: escapeHtml(booking.reference), valueText: booking.reference },
    ];
    return {
      subject, leadHtml, card,
      button: context.operatorManageUrl ? { label: copy('owner.button'), url: context.operatorManageUrl } : null,
      buttonInverted: true,
      contact: null,
    };
  }

  const greeting = customerName
    ? interpolate(copy('greeting.named'), htmlValues)
    : copy('greeting.anonymous');
  const greetingHtml = `<p style="margin:0 0 18px;font-size:17px;line-height:1.5;">${greeting}</p>`;

  const withCard = event === 'booking.confirmed' || event === 'booking.rescheduled';
  const card: EmailCardRow[] = withCard
    ? [
        { label: copy('label.date'), valueHtml: `<strong>${escapeHtml(dateLong)}</strong>`, valueText: dateLong },
        { label: copy('label.time'), valueHtml: `<strong>${escapeHtml(time)}</strong>`, valueText: time },
        { label: copy('label.guests'), valueHtml: `<strong>${booking.people}</strong>`, valueText: String(booking.people) },
        ...pickupRows,
      ]
    : [];

  const buttonKey = `${eventKey}.customer.button`;
  const buttonLabel = withCard ? copy(buttonKey) : '';
  const contactPhones = [config.business.contact.phone, config.business.contact.phoneSecondary].filter((value): value is string => Boolean(value));
  const whatsapp = config.business.contact.whatsapp;
  const whatsappIsListed = whatsapp ? contactPhones.some((phone) => digitsOf(phone) === digitsOf(whatsapp)) : false;

  return {
    subject, greetingHtml, leadHtml, card,
    button: withCard && buttonLabel && context.customerManageUrl ? { label: buttonLabel, url: context.customerManageUrl } : null,
    buttonInverted: false,
    contact: {
      lead: copy(whatsappIsListed ? 'contact.lead.whatsapp' : 'contact.lead.plain'),
      phones: contactPhones,
      whatsappLine: whatsapp && !whatsappIsListed ? `${copy('label.whatsapp')}: ${whatsapp}` : null,
    },
    footerHtml: `${escapeHtml(copy('label.bookingId'))}: ${escapeHtml(booking.reference)}`,
  };
}

const BODY_FONT = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF_FONT = "Georgia,'Times New Roman',serif";

function renderHtml(model: EmailModel, config: ClientConfig): string {
  const branding = resolvedBranding(config);
  const header = branding.logoUrl
    ? `<a href="${escapeHtml(config.business.url)}" style="text-decoration:none;"><img src="${escapeHtml(branding.logoUrl)}" alt="${escapeHtml(config.business.name)}" width="${branding.logoWidth}" height="${branding.logoHeight}" style="display:block;width:${branding.logoWidth}px;height:${branding.logoHeight}px;border:0;color:${branding.accentColor};font-family:${SERIF_FONT};font-size:20px;"></a>`
    : `<a href="${escapeHtml(config.business.url)}" style="text-decoration:none;"><span style="color:${branding.accentColor};font-family:${SERIF_FONT};font-size:22px;letter-spacing:0.5px;">${escapeHtml(config.business.name)}</span></a>`;

  const cardHtml = model.card.length
    ? `<tr><td style="padding:0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${branding.cardBackground};border-radius:8px;border-left:4px solid ${branding.accentColor};"><tr><td style="padding:20px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-family:${BODY_FONT};font-size:15px;color:#191919;line-height:2;">${model.card.map((row) => `<tr><td style="color:#8f8f8f;width:130px;vertical-align:top;">${escapeHtml(row.label)}</td><td style="font-weight:600;">${row.valueHtml}</td></tr>`).join('')}</table></td></tr></table></td></tr>`
    : '';

  const buttonHtml = model.button
    ? `<tr><td align="center" style="padding:30px 32px 8px;"><a href="${escapeHtml(model.button.url)}" style="display:inline-block;background-color:${model.buttonInverted ? branding.headerBackground : branding.accentColor};color:${model.buttonInverted ? branding.accentColor : branding.headerBackground};font-family:${BODY_FONT};font-size:15px;font-weight:700;text-decoration:none;padding:13px 34px;border-radius:6px;">${escapeHtml(model.button.label)}</a></td></tr>`
    : '';

  const contactHtml = model.contact
    ? `<tr><td align="center" style="padding:22px 32px 6px;font-family:${BODY_FONT};font-size:14px;color:#404040;line-height:1.7;">${escapeHtml(model.contact.lead)}<br>${model.contact.phones.map((phone) => `<a href="tel:${escapeHtml(phone.replace(/\s/g, ''))}" style="color:#191919;font-weight:600;text-decoration:none;">${escapeHtml(phone)}</a>`).join('<br>')}${model.contact.whatsappLine ? `<br>${escapeHtml(model.contact.whatsappLine)}` : ''}</td></tr>`
    : '';

  const footerHtml = model.footerHtml
    ? `<tr><td align="center" style="padding:18px 32px 26px;font-family:${BODY_FONT};font-size:12px;color:#a6a6a6;">${model.footerHtml}</td></tr>`
    : '<tr><td style="padding:0 0 26px;"></td></tr>';

  return `<!doctype html><html><body style="margin:0;padding:0;background-color:#e9e9e9;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#e9e9e9;"><tr><td align="center" style="padding:24px 12px;"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;"><tr><td style="background-color:${branding.headerBackground};padding:22px 32px;" align="left">${header}</td></tr><tr><td style="padding:36px 32px 8px;font-family:${SERIF_FONT};color:#191919;">${model.greetingHtml ?? ''}${model.leadHtml}</td></tr>${cardHtml}${buttonHtml}${contactHtml}${footerHtml}</table></td></tr></table></body></html>`;
}

function renderText(model: EmailModel, config: ClientConfig): string {
  const lines: string[] = [config.business.name.toUpperCase(), ''];
  if (model.greetingHtml) lines.push(stripTags(model.greetingHtml), '');
  lines.push(stripTags(model.leadHtml), '');
  for (const row of model.card) lines.push(`  ${row.label}: ${row.valueText}`);
  if (model.card.length) lines.push('');
  if (model.button) lines.push(`${model.button.label}:`, model.button.url, '');
  if (model.contact) {
    lines.push(model.contact.lead, ...model.contact.phones);
    if (model.contact.whatsappLine) lines.push(model.contact.whatsappLine);
    lines.push('');
  }
  if (model.footerHtml) lines.push(stripTags(model.footerHtml));
  return lines.join('\n').trimEnd();
}

function defaultRender(context: BrevoEmailTemplateContext): BrevoEmailContent {
  const model = buildModel(context);
  return { subject: model.subject, htmlContent: renderHtml(model, context.config), textContent: renderText(model, context.config) };
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
  // BK-SIDE-001: which recipients apply for an event, exposed so a caller (the mutation
  // dispatcher) can record + retry each recipient as its own durable operation without knowing
  // this provider's template config.
  recipientsForEvent(event: EmailBookingEvent): BrevoRecipient[] {
    const recipients: BrevoRecipient[] = ['customer'];
    if (ownerEvents.has(event)) recipients.push('owner');
    return recipients;
  }

  // BK-SIDE-001: single-recipient send, so a caller can treat the customer and owner messages as
  // independent operations — an owner-send failure here never touches the customer's address.
  async sendToRecipient(
    recipient: BrevoRecipient,
    event: EmailBookingEvent,
    booking: Booking,
    config: ClientConfig,
    routePaths?: BookkitResolvedRouteConfig['paths'],
  ): Promise<void> {
    const address = addressFor(recipient, booking, config, this.owner);
    if (!address) return;
    // BK-SEC-002 (patch-11-r1 LOW 1): '' rather than a dead link when the token isn't
    // presentable — the renderer omits the manage button for an empty URL. Kept here (not lost in
    // the sendToRecipient/send split) — see the isManageableToken doc comment.
    const context: BrevoEmailTemplateContext = { event, booking, config, locale: emailLocaleFor(booking, config), recipient, customerManageUrl: isManageableToken(booking.cancelToken) ? manageUrl(config, booking.cancelToken, routePaths) : '', operatorManageUrl: isManageableToken(booking.operatorToken) ? manageUrl(config, booking.operatorToken, routePaths) : '', startsAtLocal: localStart(booking, config) };
    const content = this.renderer(context);
    const response = await this.request(this.endpoint, { method: 'POST', headers: { accept: 'application/json', 'api-key': this.apiKey, 'content-type': 'application/json' }, body: JSON.stringify({ ...content, sender: this.sender ?? { email: config.business.contact.email, name: config.business.name }, to: [address] }) });
    if (!response.ok) throw new BrevoResponseError(response.status, await response.text());
  }

  // Kept as the whole-event send (customer then owner, sequentially, in one call) for callers
  // that don't need per-recipient tracking (e.g. the confirmation-path outbox's single
  // 'email_confirmation' operation — see src/confirmation.ts executeOperation, handoff 04's
  // territory, out of scope for this task). Implemented in terms of sendToRecipient so both paths
  // share one HTTP-call implementation.
  async send(
    event: EmailBookingEvent,
    booking: Booking,
    config: ClientConfig,
    routePaths?: BookkitResolvedRouteConfig['paths'],
  ): Promise<void> {
    for (const recipient of this.recipientsForEvent(event)) {
      await this.sendToRecipient(recipient, event, booking, config, routePaths);
    }
  }
}
export function brevoEmail(options: BrevoEmailProviderOptions): BrevoEmailProvider { return new BrevoEmailProvider(options); }
export const createBrevoEmailProvider = brevoEmail;
