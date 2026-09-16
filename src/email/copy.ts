import type { ResolvedClientConfig } from '../core/config.js';
import type { EmailBookingEvent } from '../core/events.js';

// ---------------------------------------------------------------------------
// Copy catalogs. Flat keys so a client can override any string per locale via
// config.emails.messages. {placeholders} interpolate with HTML-escaped values in htmlContent,
// raw values in subject/textContent.
// ---------------------------------------------------------------------------
export const eventCopyKey: Record<EmailBookingEvent, string> = {
  'booking.confirmed': 'confirmed',
  'booking.cancelled_by_customer': 'cancelledByCustomer',
  'booking.cancelled_by_operator': 'cancelledByOperator',
  'booking.rescheduled': 'rescheduled',
  'booking.no_show': 'noShow',
  'booking.reminder': 'reminder',
  'payment.dispute_created': 'dispute',
};

export const englishEmailCopy: Record<string, string> = {
  'greeting.named': 'Hi {customerName},',
  'greeting.anonymous': 'Hello,',
  'word.guest': 'guest',
  'word.guests': 'guests',
  'label.service': 'Service',
  'label.date': 'Date',
  'label.time': 'Time',
  'label.cancellation': 'Cancellation',
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
  'cancellation.free': 'Free cancellation until {cancelDeadline}',
  'contact.lead.whatsapp': 'Questions? Just reply to this email, or call / WhatsApp us:',
  'contact.lead.plain': 'Questions? Just reply to this email, or call us:',
  // Neutral default; a consumer can override with a concrete turnaround promise via
  // config.emails.messages — the library makes no timing guarantee on an operator's behalf.
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
  // Reminders go to the customer only; there is no owner variant, so no owner keys.
  'reminder.customer.subject': 'Reminder: {serviceTitle} — {when}',
  'reminder.customer.lead': 'A quick reminder about your <strong>{serviceTitle}</strong> — see you {when}!',
  'reminder.customer.button': 'Manage my booking',
  // A dispute is the bank's decision to make, not the customer's problem to hear about, so this
  // event has owner copy only.
  'dispute.owner.subject': 'Payment dispute opened for {reference}',
  'dispute.owner.lead': 'A payment dispute was opened for booking <strong>{reference}</strong> ({price}). Respond in your payment provider\'s dashboard before its deadline — the booking itself was left unchanged.',
  'dispute.owner.button': 'Open the admin dashboard',
  // Operational alerts, not booking mail: the audience is whoever runs the deployment, and the
  // copy deliberately carries no customer data — only what the admin dashboard already shows.
  'alert.subject': '[Reserva] Attention required: {action} for {reference}',
  'alert.body': '<strong>{action}</strong> needs attention on {reference}.<br>Severity: {severity}<br>Attempts: {attemptCount}<br>First detected: {firstDetectedAt}<br><a href="{adminUrl}">Open the admin dashboard</a>',
};

export const portuguesePortugalEmailCopy: Record<string, string> = {
  'greeting.named': 'Olá {customerName},',
  'greeting.anonymous': 'Olá,',
  'word.guest': 'pessoa',
  'word.guests': 'pessoas',
  'label.service': 'Serviço',
  'label.date': 'Data',
  'label.time': 'Hora',
  'label.cancellation': 'Cancelamento',
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
  'cancellation.free': 'Cancelamento gratuito até {cancelDeadline}',
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
  'reminder.customer.subject': 'Lembrete: {serviceTitle} — {when}',
  'reminder.customer.lead': 'Um lembrete sobre a sua reserva de <strong>{serviceTitle}</strong> — até {when}!',
  'reminder.customer.button': 'Gerir a minha reserva',
  'dispute.owner.subject': 'Contestação de pagamento aberta para {reference}',
  'dispute.owner.lead': 'Foi aberta uma contestação de pagamento para a reserva <strong>{reference}</strong> ({price}). Responda no painel do fornecedor de pagamentos antes do prazo — a reserva em si não foi alterada.',
  'dispute.owner.button': 'Abrir o painel de administração',
  'alert.subject': '[Reserva] Atenção necessária: {action} em {reference}',
  'alert.body': '<strong>{action}</strong> precisa de atenção em {reference}.<br>Gravidade: {severity}<br>Tentativas: {attemptCount}<br>Primeira deteção: {firstDetectedAt}<br><a href="{adminUrl}">Abrir o painel de administração</a>',
};

const emailCopyCatalogs: Record<string, Record<string, string>> = {
  en: englishEmailCopy, pt: portuguesePortugalEmailCopy, 'pt-PT': portuguesePortugalEmailCopy,
};

// The copy-key union so an unknown `config.emails.messages[locale]` key is a compile-time error,
// instead of a silently ignored override.
export type EmailCopyKey = keyof typeof englishEmailCopy;

function candidates(locale: string, fallback: string): string[] {
  const values: Array<string | undefined> = [locale, locale.split('-')[0], fallback, fallback.split('-')[0], 'en'];
  return values.filter((value, index): value is string => Boolean(value) && values.indexOf(value) === index);
}

export function emailString(config: ResolvedClientConfig, locale: string, key: string): string {
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
