// The published surface of `@reservajs/astro/ui`: the message catalog a consumer overrides or
// reuses, plus the formatters Reserva's own pages render with — so an embed's dates, times and
// prices match the confirmation page instead of being formatted a second, slightly different way.

export {
  defaultMessages,
  defaultLocale,
  formatMessage,
  resolveMessages,
  type ReservaMessageKey,
  type ReservaMessages,
} from './messages.js';

export {
  formatDateTime,
  formatDateTimeRange,
  formatDayDate,
  formatDateParts,
  formatPrice,
  googleCalendarUrl,
  icsDataUrl,
  icsText,
  type CalendarEvent,
} from './format.js';
