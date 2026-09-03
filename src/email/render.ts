import type { Booking } from '../core/booking.js';
import { meetingPointForBooking, metadataRowsForBooking, pickupPresentationFor, type ResolvedClientConfig } from '../core/config.js';
import { toMajorUnits } from '../core/currency.js';
import type { EmailBookingEvent, EmailRecipientRole } from '../core/events.js';
// Boolean metadata reuses the app's one existing yes/no copy pair (admin.on/off) instead of a
// second one here — the only cross-import from src/ui/ in this module.
import { resolveMessages } from '../ui/messages.js';
import { emailString, eventCopyKey } from './copy.js';

// ---------------------------------------------------------------------------
// The public, provider-neutral seam (@reservajs/astro/email, src/email/index.ts).
// ---------------------------------------------------------------------------

export interface EmailTemplateContext {
  event: EmailBookingEvent;
  booking: Booking;
  config: ResolvedClientConfig;
  locale: string;
  recipient: EmailRecipientRole;
  customerManageUrl: string;
  operatorManageUrl: string;
  startsAtLocal: string;
}

// Provider-neutral rendered result. A transport maps this to its own API vocabulary (Brevo's
// `htmlContent`/`textContent`) rather than the public renderer contract leaking one transport's
// field names.
export interface RenderedEmail { subject: string; html: string; text?: string }

export type EmailRenderer = (context: EmailTemplateContext) => RenderedEmail;

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!); }
function interpolate(template: string, values: Record<string, string>): string { return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key: string) => values[key] ?? ''); }
function stripTags(html: string): string { return html.replace(/<[^>]+>/g, ''); }

// Bare 'en' resolves to en-US date ordering (Oct 15); European operators expect 15 Oct, so
// formatting (not copy) upgrades it to en-GB. Exported so a transport building an
// `EmailTemplateContext` can format `startsAtLocal` consistently.
export function formatLocaleFor(locale: string): string { return locale === 'en' ? 'en-GB' : locale; }

function digitsOf(value: string): string { return value.replace(/\D/g, ''); }

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

export const NEUTRAL_BRANDING = {
  logoUrl: undefined as string | undefined, logoWidth: 200, logoHeight: 28,
  headerBackground: '#1a1a1a', accentColor: '#e0b64a', cardBackground: '#f7f7f5',
};

function resolvedBranding(config: ResolvedClientConfig): typeof NEUTRAL_BRANDING {
  const branding = config.emails?.branding;
  return {
    logoUrl: branding?.logoUrl ?? NEUTRAL_BRANDING.logoUrl,
    logoWidth: branding?.logoWidth ?? NEUTRAL_BRANDING.logoWidth,
    logoHeight: branding?.logoHeight ?? NEUTRAL_BRANDING.logoHeight,
    headerBackground: branding?.headerBackground ?? NEUTRAL_BRANDING.headerBackground,
    accentColor: branding?.accentColor ?? NEUTRAL_BRANDING.accentColor,
    cardBackground: branding?.cardBackground ?? NEUTRAL_BRANDING.cardBackground,
  };
}

function buildModel(context: EmailTemplateContext): EmailModel {
  const { event, booking, config, locale, recipient } = context;
  const copy = (key: string) => emailString(config, locale, key);
  const eventKey = eventCopyKey[event];
  const service = config.services[booking.serviceSlug];
  const serviceTitle = service?.title ?? booking.serviceSlug;
  const formatLocale = formatLocaleFor(locale);
  const timeZone = config.business.timezone;
  const startsAt = new Date(booking.startsAt);
  const time = new Intl.DateTimeFormat(formatLocale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(startsAt);
  const when = `${new Intl.DateTimeFormat(formatLocale, { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(startsAt)}, ${time}`;
  const dateLong = new Intl.DateTimeFormat(formatLocale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone }).format(startsAt);
  const guestsWord = copy(booking.quantity === 1 ? 'word.guest' : 'word.guests');
  const customerName = booking.customerName ?? '';

  const rawValues: Record<string, string> = {
    serviceTitle, when, customerName, reference: booking.reference,
    quantity: String(booking.quantity), guestsWord, startsAtLocal: context.startsAtLocal,
    // Copy key so a consumer can override with a concrete promise, interpolated like every
    // other placeholder.
    refundTiming: copy('refund.timing'),
  };
  const htmlValues = Object.fromEntries(Object.entries(rawValues).map(([key, value]) => [key, escapeHtml(value)]));

  // A removed meeting-point id falls back to the booking's stored label snapshot with no maps
  // link. requiresAddress/usesMeetingPoint are independent, so an option declaring both renders
  // both rows; a location-less booking gets neither.
  const presentation = service ? pickupPresentationFor(service, booking) : null;
  const resolvedPoint = service && presentation ? meetingPointForBooking(service, booking.meetingPointId ?? null, booking.meetingPointLabel ?? null) : null;
  const requiresAddress = presentation?.requiresAddress ?? false;
  const usesMeetingPoint = presentation?.usesMeetingPoint ?? false;

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

  // Same `metadataRowsForBooking` projection the manage/confirmation payloads use, built into
  // card rows here since this renderer builds its own HTML. Every value is attacker-controlled
  // free text, escaped like every other card row.
  const metadataRows = service ? metadataRowsForBooking(service, booking.metadata, locale, config.locales.default) : [];
  const onOffMessages = metadataRows.length > 0 ? resolveMessages(config, locale) : null;
  const metadataCardRows: EmailCardRow[] = metadataRows.map((row) => {
    const displayValue = typeof row.value === 'boolean'
      ? (row.value ? onOffMessages!['admin.on'] : onOffMessages!['admin.off'])
      : String(row.value);
    return { label: row.label, valueHtml: `<strong>${escapeHtml(displayValue)}</strong>`, valueText: displayValue };
  });

  const subject = interpolate(copy(`${eventKey}.${recipient}.subject`), rawValues);
  const leadHtml = `<p style="margin:0 0 26px;font-size:17px;line-height:1.5;">${interpolate(copy(`${eventKey}.${recipient}.lead`), htmlValues)}</p>`;

  if (recipient === 'owner') {
    const price = new Intl.NumberFormat(formatLocale, { style: 'currency', currency: config.business.currency.toUpperCase() }).format(toMajorUnits(booking.priceMinor, config.business.currency));
    const card: EmailCardRow[] = [
      { label: copy('label.date'), valueHtml: `<strong>${escapeHtml(`${dateLong}, ${time}`)}</strong>`, valueText: `${dateLong}, ${time}` },
      { label: copy('label.guests'), valueHtml: `<strong>${booking.quantity}</strong>`, valueText: String(booking.quantity) },
      { label: copy('label.paid'), valueHtml: `<strong>${escapeHtml(price)}</strong>`, valueText: price },
      ...pickupRows,
      ...metadataCardRows,
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
        { label: copy('label.guests'), valueHtml: `<strong>${booking.quantity}</strong>`, valueText: String(booking.quantity) },
        ...pickupRows,
        ...metadataCardRows,
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

function renderHtml(model: EmailModel, config: ResolvedClientConfig): string {
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

function renderText(model: EmailModel, config: ResolvedClientConfig): string {
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

// The one default template, exported so a transport constructs it automatically and a custom
// EmailRenderer can delegate events it doesn't want to replace.
export function renderDefaultEmail(context: EmailTemplateContext): RenderedEmail {
  const model = buildModel(context);
  return { subject: model.subject, html: renderHtml(model, context.config), text: renderText(model, context.config) };
}
