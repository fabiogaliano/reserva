import type { ClientConfig } from '../core/config.js';
import type { EmailBookingEvent } from '../core/events.js';

// ---------------------------------------------------------------------------
// Copy catalogs. Flat keys so a client can override any string per locale via
// config.emails.messages — the same merge pattern ui.messages uses for widget
// copy. {placeholders} interpolate with HTML-escaped values in htmlContent and
// raw values in subject/textContent.
// ---------------------------------------------------------------------------
export const eventCopyKey: Record<EmailBookingEvent, string> = {
  'booking.confirmed': 'confirmed',
  'booking.cancelled_by_customer': 'cancelledByCustomer',
  'booking.cancelled_by_operator': 'cancelledByOperator',
  'booking.rescheduled': 'rescheduled',
  'booking.no_show': 'noShow',
};

export const englishEmailCopy: Record<string, string> = {
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
  // A neutral default a consumer can override with a concrete
  // turnaround promise via config.emails.messages — the library has no business making a timing
  // guarantee on any operator's behalf.
  'refund.timing': 'Refunds are returned to your original payment method.',
  'confirmed.customer.subject': 'Booking confirmed: {serviceTitle} — {when}',
  'confirmed.customer.lead': 'Your <strong>{serviceTitle}</strong> is confirmed — we look forward to seeing you!',
  'confirmed.customer.button': 'Manage my booking',
  'confirmed.owner.subject': 'New booking: {serviceTitle} — {when} · {quantity} {guestsWord}',
  'confirmed.owner.lead': '<strong>{customerName}</strong> booked <strong>{serviceTitle}</strong>.',
  'owner.button': 'Open booking actions',
  'cancelledByCustomer.customer.subject': 'Booking cancelled: {serviceTitle} — {when}',
  'cancelledByCustomer.customer.lead': 'Your <strong>{serviceTitle}</strong> on {when} has been cancelled. {refundTiming}',
  'cancelledByCustomer.owner.subject': 'Customer cancelled: {serviceTitle} — {when}',
  'cancelledByCustomer.owner.lead': '<strong>{customerName}</strong> cancelled <strong>{serviceTitle}</strong>.',
  'cancelledByOperator.customer.subject': 'Your booking was cancelled: {serviceTitle} — {when}',
  'cancelledByOperator.customer.lead': "We're sorry — your <strong>{serviceTitle}</strong> on {when} had to be cancelled. {refundTiming}",
  'cancelledByOperator.owner.subject': 'Booking cancelled: {serviceTitle} — {when}',
  'cancelledByOperator.owner.lead': 'Booking <strong>{reference}</strong> was cancelled by the operator.',
  'rescheduled.customer.subject': 'Booking rescheduled: {serviceTitle} — {when}',
  'rescheduled.customer.lead': 'Your <strong>{serviceTitle}</strong> has a new date.',
  'rescheduled.customer.button': 'Manage my booking',
  'rescheduled.owner.subject': 'Booking rescheduled: {serviceTitle} — {when}',
  'rescheduled.owner.lead': 'Booking <strong>{reference}</strong> is now scheduled for {when}.',
  'noShow.customer.subject': 'Booking update: {serviceTitle} — {when}',
  'noShow.customer.lead': 'Your booking for <strong>{serviceTitle}</strong> on {when} was marked as a no-show. If you think this is a mistake, just reply to this email.',
  'noShow.owner.subject': 'No-show: {serviceTitle} — {when}',
  'noShow.owner.lead': 'Booking <strong>{reference}</strong> was marked as a no-show.',
};

export const portuguesePortugalEmailCopy: Record<string, string> = {
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
  'refund.timing': 'Os reembolsos são devolvidos ao seu método de pagamento original.',
  'confirmed.customer.subject': 'Reserva confirmada: {serviceTitle} — {when}',
  'confirmed.customer.lead': 'A sua reserva de <strong>{serviceTitle}</strong> está confirmada — esperamos por si!',
  'confirmed.customer.button': 'Gerir a minha reserva',
  'confirmed.owner.subject': 'Nova reserva: {serviceTitle} — {when} · {quantity} {guestsWord}',
  'confirmed.owner.lead': '<strong>{customerName}</strong> reservou <strong>{serviceTitle}</strong>.',
  'owner.button': 'Abrir ações da reserva',
  'cancelledByCustomer.customer.subject': 'Reserva cancelada: {serviceTitle} — {when}',
  'cancelledByCustomer.customer.lead': 'A sua reserva de <strong>{serviceTitle}</strong> para {when} foi cancelada. {refundTiming}',
  'cancelledByCustomer.owner.subject': 'Cancelamento pelo cliente: {serviceTitle} — {when}',
  'cancelledByCustomer.owner.lead': '<strong>{customerName}</strong> cancelou <strong>{serviceTitle}</strong>.',
  'cancelledByOperator.customer.subject': 'A sua reserva foi cancelada: {serviceTitle} — {when}',
  'cancelledByOperator.customer.lead': 'Lamentamos — a sua reserva de <strong>{serviceTitle}</strong> para {when} teve de ser cancelada. {refundTiming}',
  'cancelledByOperator.owner.subject': 'Reserva cancelada: {serviceTitle} — {when}',
  'cancelledByOperator.owner.lead': 'A reserva <strong>{reference}</strong> foi cancelada pelo operador.',
  'rescheduled.customer.subject': 'Reserva alterada: {serviceTitle} — {when}',
  'rescheduled.customer.lead': 'A sua reserva de <strong>{serviceTitle}</strong> tem uma nova data.',
  'rescheduled.customer.button': 'Gerir a minha reserva',
  'rescheduled.owner.subject': 'Reserva alterada: {serviceTitle} — {when}',
  'rescheduled.owner.lead': 'A reserva <strong>{reference}</strong> está agora marcada para {when}.',
  'noShow.customer.subject': 'Atualização da reserva: {serviceTitle} — {when}',
  'noShow.customer.lead': 'A sua reserva de <strong>{serviceTitle}</strong> para {when} foi marcada como não comparecimento. Se acha que se trata de um erro, responda a este email.',
  'noShow.owner.subject': 'Não comparecimento: {serviceTitle} — {when}',
  'noShow.owner.lead': 'A reserva <strong>{reference}</strong> foi marcada como não comparecimento.',
};

const emailCopyCatalogs: Record<string, Record<string, string>> = {
  en: englishEmailCopy, pt: portuguesePortugalEmailCopy, 'pt-PT': portuguesePortugalEmailCopy,
};

// The copy-key union so an unknown `config.emails.messages[locale]` key is a compile-time error
// for TS consumers (ClientConfig's emails.messages field type references this) instead of a
// silently ignored override — runtime behavior for an actually-unknown key is unchanged.
export type EmailCopyKey = keyof typeof englishEmailCopy;

function candidates(locale: string, fallback: string): string[] {
  const values: Array<string | undefined> = [locale, locale.split('-')[0], fallback, fallback.split('-')[0], 'en'];
  return values.filter((value, index): value is string => Boolean(value) && values.indexOf(value) === index);
}

export function emailString(config: ClientConfig, locale: string, key: string): string {
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
