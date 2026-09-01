// Single key set for every string bookkit renders to a customer or operator. English is the
// default and the fallback; European Portuguese ships as a bundled catalog a consumer selects via
// `config.locales`, and both can be overridden per locale through `config.ui.messages`.

import type { ClientConfig } from '../core/config';
import portuguesePortugalCatalog from './locales/pt-PT.json';

export const defaultMessages = {
  // Shared
  'common.brandFallback': 'Bookings',
  'common.reference': 'Reference',
  'common.service': 'Service',
  'common.date': 'Date',
  'common.time': 'Time',
  'common.quantity': 'People',
  'common.pickup': 'Pickup',
  'common.customer': 'Customer',
  'common.email': 'Email',
  'common.phone': 'Phone',
  'common.pickupAddress': 'Pickup address',
  'common.price': 'Total price',
  'common.status': 'Status',
  'common.meetingPoint': 'Meeting point',
  'common.openInMaps': 'Open in Google Maps',
  'common.back': 'Back',
  'common.skipContent': 'Skip to content',
  // Theme toggle (System → Light → Dark). `theme.toggle` is the control's accessible-name prefix.
  'theme.toggle': 'Theme',
  'theme.system': 'System',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  // Booking statuses
  'status.confirmed': 'Confirmed',
  'status.hold': 'Awaiting payment',
  'status.cancelled': 'Cancelled',
  'status.expired': 'Expired',
  'status.no_show': 'No-show',
  // Widget
  'widget.title': 'Book now',
  'widget.quantity': 'How many people?',
  'widget.person': '{n} person',
  'widget.quantityCount': '{n} people',
  'widget.date': 'Pick a date',
  'widget.time': 'Pick a time',
  'widget.loadingSlots': 'Checking availability…',
  'widget.noSlots': 'No times available for this date',
  'widget.noDates': 'No dates available for this party size',
  'widget.closed': 'Closed',
  'widget.soldOut': 'Sold out',
  'widget.limited': 'Only {n} left',
  'widget.spotsLeft': '{n} spots left',
  'widget.pickup': 'Where do we meet?',
  'widget.pickupDefault': 'Meeting point',
  'widget.pickupDefaultHint': 'Meet us at the starting point',
  'widget.pickupCustom': 'Custom pickup',
  'widget.pickupCustomHint': 'We pick you up at your address',
  // Plan 017 (design decision 5): legend for the meetingPointId radio group, shown only when a
  // service declares 2+ points — labels themselves are config-provided plain strings, like
  // meetingPoint.label today.
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
  // Confirmation page
  'confirmation.title': 'Booking confirmed',
  'confirmation.lead': 'Thank you — your booking is confirmed. A confirmation email is on its way.',
  'confirmation.detailsEmailed': 'Your booking is confirmed. Full details and a link to manage your booking were emailed to you.',
  'confirmation.whatsNextTitle': "What's next",
  'confirmation.whatsNextBody': 'Save your reference and arrive a few minutes early. If you chose a custom pickup, we will contact you to confirm the address.',
  'confirmation.addToCalendar': 'Add to calendar',
  'confirmation.addGoogle': 'Google Calendar',
  'confirmation.addIcs': 'Apple / Outlook (.ics)',
  'confirmation.pendingTitle': 'Confirming your payment…',
  'confirmation.pendingBody': 'This page updates automatically. It usually takes a few seconds.',
  'confirmation.expiredTitle': 'Checkout expired',
  'confirmation.expiredBody': 'No confirmed payment was found for this session. Your card was not charged — you can start a new booking.',
  'confirmation.cancelledTitle': 'Booking cancelled',
  'confirmation.cancelledBody': 'This booking was cancelled and is no longer active.',
  'confirmation.notFoundTitle': 'Booking not found',
  'confirmation.notFoundBody': 'We could not find a booking for this link. Check the link from your email, or start a new booking.',
  'confirmation.startOver': 'Start a new booking',
  // Manage page
  'manage.title': 'Manage booking',
  'manage.entryTitle': 'Manage your booking',
  'manage.entryHint': 'Paste the booking link or token from your confirmation email.',
  'manage.entryToken': 'Booking token',
  'manage.entryOpen': 'Open booking',
  'manage.yourBooking': 'Your booking',
  'manage.cancelTitle': 'Cancel booking',
  'manage.cancelWarning': 'Cancelling frees your slot and cannot be undone.',
  'manage.cancelPolicy': 'Free cancellation until {deadline}.',
  'manage.cancelConfirm': 'Yes, cancel this booking',
  'manage.cancelled': 'This booking has been cancelled.',
  'manage.rescheduleTitle': 'Reschedule',
  'manage.rescheduleHint': 'Choose a new start time. Your price and party size stay the same.',
  'manage.newStart': 'New start',
  'manage.rescheduleSubmit': 'Reschedule booking',
  'manage.rescheduled': 'Booking rescheduled — the updated time is shown below.',
  'manage.pastCutoff': 'The change deadline for this booking has passed. Contact us if you need help.',
  'manage.errorSlotTaken': 'That time is no longer available — it may have just been booked. Please pick another time.',
  'manage.errorNotChangeable': 'This booking can no longer be changed.',
  'manage.actionFailed': 'Something went wrong and nothing was changed. Please try again.',
  'manage.refund': 'Refund',
  'manage.refundNone': 'No refund',
  'manage.refundFull': 'Full refund',
  'manage.noShowSubmit': 'Mark as no-show',
  'manage.noShowWarning': 'This marks the booking as missed by the customer and cannot be undone.',
  'manage.operatorBadge': 'Operator view',
  'manage.invalidTitle': 'Link not valid',
  'manage.invalidBody': 'This booking link is invalid or has expired. Use the exact link from your confirmation email, or contact us.',
  // Admin
  'admin.title': 'Booking admin',
  'admin.workspace': 'Operations',
  'admin.pageHint': 'A live view of upcoming bookings, daily capacity, and anything that needs attention.',
  'admin.navigation': 'Admin navigation',
  'admin.onThisPage': 'On this page',
  'admin.navOverview': 'Dashboard',
  'admin.navBookings': 'Upcoming bookings',
  'admin.navDays': 'Availability',
  'admin.days': 'Availability by day',
  'admin.daysHint': 'Each day shows units used/capacity. Select a day to adjust or close it.',
  'admin.unitsLoad': 'units {booked}/{capacity}',
  'admin.bookings': 'Upcoming bookings',
  'admin.noBookings': 'No upcoming bookings.',
  'admin.capacity': 'Capacity',
  'admin.stateOverride': 'Adjusted',
  'admin.reason': 'Reason',
  'admin.overrideTitle': 'Adjust one day',
  'admin.overrideHint': 'Change how many bookings a day can take, or close it.',
  'admin.overrideDefault': 'Reset returns the day to the default of {n}.',
  'admin.overrideTo': 'To date (optional)',
  'admin.selectHint': 'Select a day. Shift-click selects a range; Ctrl/Cmd-click adds individual days. Keyboard: use Tab, then Enter or Space.',
  'admin.addReason': 'Add a reason (optional)',
  'admin.selectedDays': '{n} days selected',
  'admin.close': 'Close this day',
  'admin.closeMany': 'Close {n} days',
  'admin.dayNoBookings': 'No bookings on this day.',
  'admin.prevMonth': 'Previous month',
  'admin.nextMonth': 'Next month',
  'admin.save': 'Save',
  'admin.clear': 'Reset to default',
  'admin.defaultTitle': 'Schedule a capacity change',
  'admin.defaultHint': 'Use when capacity changes from a specific date, like a unit becoming unavailable. This overrides the normal capacity. Individually adjusted days keep their own value.',
  'admin.defaultScheduled': '{n} scheduled',
  'admin.monthFlagged': '{n} adjusted',
  'admin.defaultFrom': 'From date',
  'admin.defaultEntry': '{n} from {date}',
  'admin.remove': 'Remove',
  'admin.search': 'Search',
  'admin.searchPlaceholder': 'Reference, service, pickup…',
  // Plan 023 (design decision 4): shown instead of the key above when no configured service
  // declares a location module.
  'admin.searchPlaceholderNoPickup': 'Reference, service…',
  'admin.filterStatus': 'Status',
  'admin.all': 'All',
  'admin.apply': 'Apply filters',
  'admin.manage': 'Manage',
  // BK-SEC-002 (patch-11-r1 LOW 1): shown instead of a manage-link href when the booking's
  // operatorToken isn't presentable (see isManageableToken, src/providers/brevo.ts) — a
  // not-yet-backfilled legacy row, or no BOOKKIT_TOKEN_ENC_KEY configured at all.
  'admin.manageUnavailable': 'Manage link unavailable',
  'admin.results': '{n} bookings',
  'admin.resultsOne': '{n} booking',
  'admin.clearFilters': 'Clear filters',
  'admin.metricUpcoming': 'Upcoming',
  'admin.metricConfirmed': 'Confirmed',
  'admin.metricHolds': 'Awaiting payment',
  'admin.metricAttention': 'Needs attention',
  // Admin settings page
  'admin.settings': 'Settings',
  'admin.settingsHint': 'Changes apply within a minute and survive deploys.',
  'admin.backToAdmin': 'Back to booking admin',
  'admin.saved': 'Saved. Changes reach the public site within a minute.',
  'admin.sectionPolicy': 'Booking policy',
  'admin.sectionPolicyHint': 'The rules customers book, cancel and reschedule under.',
  'admin.sectionCapacity': 'Capacity',
  'admin.sectionCapacityHint': 'Set how many concurrent bookings are normally available.',
  'admin.sectionContact': 'Business & contact',
  'admin.sectionContactHint': 'Shown to customers on booking pages and emails.',
  'admin.sectionLegal': 'Legal',
  'admin.sectionLegalHint': 'Documents linked from the booking flow.',
  'admin.sectionReadonly': 'Deploy-time settings',
  'admin.readonlyHint': 'These cannot be changed here. Edit the site’s Bookkit config file and redeploy.',
  'admin.modified': 'Modified',
  'admin.default': 'Default: {v}',
  'admin.resetField': 'Reset',
  'admin.resetSection': 'Reset section to defaults',
  'admin.on': 'On',
  'admin.off': 'Off',
  'admin.none': 'None',
  // Shown by the embeddable AdminDashboard component in place of its override form when the
  // viewing request isn't Cloudflare Access-authenticated (see src/components/AdminDashboard.astro)
  // — rendering a form that could only ever 403 on submit is worse than saying so up front.
  'admin.accessRequired': 'Cloudflare Access authorization required to manage this booking.',
  'settingGroup.window': 'Booking window',
  'settingGroup.changes': 'Cancellation & rescheduling',
  'settingGroup.holds': 'Checkout holds & availability',
  'setting.minNoticeHours': 'Minimum notice (hours)',
  'setting.minNoticeHours.hint': 'How close to the start time a new booking can still be made.',
  'setting.maxHorizonDays': 'Booking horizon (days)',
  'setting.maxHorizonDays.hint': 'How far into the future customers can book.',
  'setting.holdMinutes': 'Payment hold (minutes)',
  'setting.holdMinutes.hint': 'How long an unpaid checkout keeps its spot reserved.',
  'setting.cancelCutoffHours': 'Cancellation cutoff (hours)',
  'setting.cancelCutoffHours.hint': 'Customers can cancel until this long before the start.',
  'setting.rescheduleEnabled': 'Allow customers to reschedule',
  'setting.rescheduleCutoffHours': 'Reschedule cutoff (hours)',
  'setting.rescheduleCutoffHours.hint': 'Customers can move a booking until this long before the start.',
  'setting.limitedThreshold': 'Low-availability warning',
  'setting.limitedThreshold.hint': 'Show “only N left” once remaining spots drop to this number. 0 turns it off.',
  'setting.maxHoldsPerIp': 'Max holds per visitor',
  'setting.maxHoldsPerIp.hint': 'Stops one visitor reserving many spots with unpaid checkouts. Leave empty for no limit.',
  'setting.businessName': 'Business name',
  'setting.contactEmail': 'Contact email',
  'setting.contactPhone': 'Contact phone',
  'setting.contactWhatsapp': 'WhatsApp number',
  'setting.contactWhatsapp.hint': 'Optional. Leave empty to hide WhatsApp contact.',
  'setting.termsUrl': 'Terms & conditions URL',
  'setting.termsUrl.hint': 'Linked wherever booking terms are shown.',
  'setting.timezone': 'Timezone',
  'setting.currency': 'Currency',
  'setting.locales': 'Languages',
  'setting.shortCode': 'Reference prefix',
  'setting.siteUrl': 'Site URL',
  'setting.services': 'Services',
  'setting.capacity': 'Concurrent bookings',
  'setting.capacity.hint': 'Applies to dates without a scheduled or day-specific capacity change. Set to 0 to stop availability everywhere.',
  // Plan 020 (design decision 12/13/14): operator incident cards on the admin page.
  'admin.navIncidents': 'Attention required',
  'admin.incidentsTitle': 'Attention required',
  'admin.incidentsHint': 'Bookings where something automatic did not complete. Most clear themselves once the underlying service recovers.',
  'admin.incidentsNone': 'Nothing needs attention right now.',
  'admin.incidentSeverityDelayed': 'Delayed',
  'admin.incidentSeverityActionRequired': 'Needs action',
  'admin.incidentAttempts': '{n} attempts so far',
  'admin.incidentSince': 'First seen {date}',
  'admin.incidentDetails': 'Technical details',
  'admin.incidentRetry': 'Try again',
  'admin.incidentRetryDuplicateWarning': 'This may send a duplicate to the customer if the original attempt actually went through.',
  'admin.incidentNoRetry': 'This needs manual handling — no automatic retry is available.',
  'admin.incidentResolveNoteLabel': 'What did you do?',
  'admin.incidentResolveNoteHint': 'Required, 1-500 characters. Recorded against your Access account and this incident only — it never changes the underlying booking.',
  'admin.incidentResolveSubmit': 'I handled this manually',
  'admin.incidentRetried': 'Retry attempted. Refresh to see whether it cleared.',
  'admin.incidentRetryFailed': 'The retry ran but did not succeed. It will keep retrying automatically.',
  'admin.incidentRetryNotAvailable': 'This cannot be retried automatically.',
  'admin.incidentResolved': 'Marked as handled.',
  'admin.incidentHistory': 'Recently resolved',
  'admin.incidentHistoryNone': 'No incidents resolved in the last 30 days.',
  'admin.incidentHistoryAutomatic': 'Resolved automatically',
  'admin.incidentHistoryManual': 'Resolved manually by {who}',
  'admin.incidentCounts30d': '{opened} opened, {resolved} resolved in the last 30 days',
} as const;

export type BookkitMessageKey = keyof typeof defaultMessages;
export type BookkitMessages = Record<BookkitMessageKey, string>;

// Plan 026 (design decision 4): a generic library must not default to Portuguese. Both real
// consumers (consumer-a, consumer-b) set config.locales.default explicitly, so this only
// changes behavior for a caller of resolveMessages/the components with no locale argument at all.
export const defaultLocale = 'en';

const portuguesePortugalMessages: BookkitMessages = portuguesePortugalCatalog;
const bundledCatalogs: Record<string, BookkitMessages> = {
  'pt-pt': portuguesePortugalMessages,
};

function localeCandidates(locale: string): string[] {
  const normalized = locale.replace('_', '-').toLowerCase();
  const base = normalized.split('-')[0] ?? normalized;
  return base && base !== normalized ? [base, normalized] : [normalized];
}

function catalogFor(catalogs: Record<string, Record<string, string>>, locale: string): Record<string, string> | undefined {
  const exact = catalogs[locale];
  if (exact) return exact;
  return Object.entries(catalogs).find(([candidate]) => candidate.toLowerCase() === locale)?.[1];
}

// Regional catalogs layer over their base language, and deployment overrides layer over bundled
// copy so a business can customize wording without maintaining a complete catalog.
export function resolveMessages(config: ClientConfig | undefined, locale: string | undefined): BookkitMessages {
  const merged: Record<string, string> = { ...defaultMessages };
  const candidates = localeCandidates(locale ?? defaultLocale);
  for (const candidate of candidates) {
    const bundled = bundledCatalogs[candidate];
    if (bundled) Object.assign(merged, bundled);
  }
  const catalogs = config?.ui?.messages;
  if (catalogs) {
    for (const candidate of candidates) {
      const overrides = catalogFor(catalogs, candidate);
      if (overrides) Object.assign(merged, overrides);
    }
  }
  return merged as BookkitMessages;
}

export function formatMessage(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}
