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
  'widget.spotsLeft': '{n} spots left',
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
  'widget.retry': 'Retry',
  'widget.noscript': 'Booking requires JavaScript. Please contact us directly to book.',
} as const;

export type WidgetMessageKey = keyof typeof defaultWidgetMessages;
export type WidgetMessages = Record<WidgetMessageKey, string>;

// The availability API returns structured scarcity, never rendered status text — this is the
// closed set of keys that renders it. `widget.limited`/`widget.spotsLeft` interpolate {n} from a
// slot's non-null `remaining`.
export const SLOT_STATUS_MESSAGE_KEYS = [
  'widget.limited', 'widget.spotsLeft', 'widget.soldOut', 'widget.noSlots', 'widget.closed',
] as const satisfies readonly (WidgetMessageKey | ReservaMessageKey)[];

export type SlotStatusMessageKey = (typeof SLOT_STATUS_MESSAGE_KEYS)[number];

const catalogs: Record<string, WidgetMessages> = {
  'pt-pt': {
    'widget.title': 'Reservar agora',
    'widget.quantity': 'Quantas pessoas?',
    'widget.noDates': 'Não há datas disponíveis para este número de pessoas',
    'widget.soldOut': 'Esgotado',
    'widget.spotsLeft': '{n} lugares disponíveis',
    'widget.pickup': 'Onde nos encontramos?',
    'widget.meetingPoint': 'Escolha um ponto de encontro',
    'widget.start': 'Início',
    'widget.startPlaceholder': 'Selecione uma hora de início',
    'widget.submit': 'Continuar para o pagamento',
    'widget.submitting': 'A redirecionar para o pagamento seguro…',
    'widget.priceNote': 'Preço para o seu grupo, impostos incluídos',
    'widget.errorAvailability': 'Não foi possível carregar a disponibilidade. Tente novamente.',
    'widget.errorCheckout': 'O pagamento falhou. Tente novamente.',
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
