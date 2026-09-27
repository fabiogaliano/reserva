// Copy for BookingWidget.astro. Reserva ships no customer booking funnel, so these strings are
// the example's own rather than library message keys — a consumer building a funnel owns its
// wording the same way. Keys the library still renders itself (party-size and slot-picker copy,
// used by the manage and admin pages) stay in `@reservajs/astro/ui` and are merged in by the
// component, not duplicated here.
import type { ReservaMessageKey } from '../../../../src/ui/messages';

export const defaultWidgetMessages = {
  'widget.title': 'Book now',
  'widget.quantity': 'How many people?',
  'widget.noDates': 'No dates available for this party size',
  'widget.soldOut': 'Sold out',
  'widget.pickup': 'Where do we meet?',
  // Shown only when a service declares 2+ meeting points.
  'widget.meetingPoint': 'Choose a meeting point',
  'widget.start': 'Start',
  'widget.startPlaceholder': 'Select a start time',
  'widget.submit': 'Continue to payment',
  'widget.submitting': 'Redirecting to secure payment…',
  'widget.priceNote': 'Price for your group, taxes included',
  'widget.errorAvailability': 'Could not load availability. Please try again.',
  'widget.errorCheckout': 'Checkout failed. Please try again.',
  'widget.errorSlotUnavailable': 'That time is no longer available. Please pick another one.',
  'widget.errorTooManyHolds': 'There are too many unfinished bookings from your connection. Please wait a few minutes and try again.',
  'widget.errorValidation': 'Some of your details were not accepted. Please check the form and try again.',
  // {field} is the field's own label, as the visitor saw it.
  'widget.errorField': 'Please check “{field}”.',
  'widget.errorCalendar': 'We could not confirm availability just now. Please try again in a moment.',
  'widget.errorNetwork': 'Connection problem. Check your internet connection and try again.',
  'widget.details': 'Your details',
  'widget.optional': '(optional)',
  'widget.retry': 'Retry',
  'widget.noscript': 'Booking requires JavaScript. Please contact us directly to book.',
} as const;

export type WidgetMessageKey = keyof typeof defaultWidgetMessages;
export type WidgetMessages = Record<WidgetMessageKey, string>;

// The availability API returns structured scarcity, never rendered status text — this is the
// closed set of keys that renders it. `widget.limited`/`widget.limitedOne` interpolate {n} from a
// slot's non-null `remaining`.
export const SLOT_STATUS_MESSAGE_KEYS = [
  'widget.limited', 'widget.limitedOne', 'widget.soldOut', 'widget.noSlots', 'widget.closed',
] as const satisfies readonly (WidgetMessageKey | ReservaMessageKey)[];

export type SlotStatusMessageKey = (typeof SLOT_STATUS_MESSAGE_KEYS)[number];

const catalogs: Record<string, WidgetMessages> = {
  'pt-pt': {
    'widget.title': 'Reservar agora',
    'widget.quantity': 'Quantas pessoas?',
    'widget.noDates': 'Não há datas disponíveis para este número de pessoas',
    'widget.soldOut': 'Esgotado',
    'widget.pickup': 'Onde nos encontramos?',
    'widget.meetingPoint': 'Escolha um ponto de encontro',
    'widget.start': 'Início',
    'widget.startPlaceholder': 'Selecione uma hora de início',
    'widget.submit': 'Continuar para o pagamento',
    'widget.submitting': 'A redirecionar para o pagamento seguro…',
    'widget.priceNote': 'Preço para o seu grupo, impostos incluídos',
    'widget.errorAvailability': 'Não foi possível carregar a disponibilidade. Tente novamente.',
    'widget.errorCheckout': 'O pagamento falhou. Tente novamente.',
    'widget.errorSlotUnavailable': 'Esse horário já não está disponível. Escolha outro.',
    'widget.errorTooManyHolds': 'Há demasiadas reservas por concluir a partir da sua ligação. Aguarde alguns minutos e tente novamente.',
    'widget.errorValidation': 'Alguns dos seus dados não foram aceites. Verifique o formulário e tente novamente.',
    'widget.errorField': 'Verifique o campo “{field}”.',
    'widget.errorCalendar': 'Não foi possível confirmar a disponibilidade neste momento. Tente novamente dentro de instantes.',
    'widget.errorNetwork': 'Problema de ligação. Verifique a sua ligação à internet e tente novamente.',
    'widget.details': 'Os seus dados',
    'widget.optional': '(opcional)',
    'widget.retry': 'Tentar novamente',
    'widget.noscript': 'A reserva requer JavaScript. Contacte-nos diretamente para reservar.',
  },
};

// Mirrors the library's own resolution: a regional tag falls back to its base language, and an
// unknown locale falls back to English.
export function resolveWidgetMessages(locale: string): WidgetMessages {
  const normalized = locale.replace('_', '-').toLowerCase();
  const base = normalized.split('-')[0] ?? normalized;
  return {
    ...defaultWidgetMessages,
    ...(base !== normalized ? catalogs[base] : undefined),
    ...catalogs[normalized],
  };
}
