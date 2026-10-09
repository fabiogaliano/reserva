// Single key set for every string reserva renders. English is the default and fallback; European
// Portuguese ships as a bundled catalog, and both can be overridden per locale via `config.ui.messages`.

import type { ResolvedClientConfig } from '../core/config.js';
// The import attribute is what makes the published `dist/` loadable by a plain ESM runtime, not
// only by a bundler: Node refuses a JSON module without it.
import portuguesePortugalCatalog from './locales/pt-PT.json' with { type: 'json' };

export const defaultMessages = {
  'admin.historyPartnerUpdated': 'Updated partner {id}',
  'admin.partners': 'Partners',
  'partner.create': 'Create partner',
  'partner.edit': 'Edit partner',
  'partner.name': 'Display name (operator only)',
  'partner.code': 'Referral code',
  'partner.codeHint': '1–64 lowercase letters, numbers, hyphens or underscores. Codes cannot be changed or reused.',
  'partner.state': 'Partner status',
  'partner.active': 'Active',
  'partner.archived': 'Archived',
  'partner.enabled': 'Offer enabled',
  'partner.disabled': 'Offer disabled',
  'partner.percentage': 'Service discount (%)',
  'partner.scope': 'Applies to the service only, not pickup charges, across all sold tours. Up to two decimal places.',
  'partner.pickups': 'Waive pickup charges',
  'partner.save': 'Save partner',
  'partner.archive': 'Archive partner',
  'partner.archiveHint': 'Archiving stops new attribution and benefits. Existing bookings keep their attribution and prices. The code stays reserved.',
  'partner.gateOff': 'Offer application is globally off. Offers can be prepared here but customers receive no benefits until the server gate is deliberately enabled.',
  'partner.none': 'No offer',
  'partner.summary': '{percentage}% off service; waived pickup: {pickups}',
  'partner.noPickups': 'none',
  'partner.copy': 'Copy referral link',
  'partner.copied': 'Copied',
  'partner.link': 'Referral link',
  'partner.eligibility': 'Links are shareable and codes are guessable. This is referral attribution, not verified guest eligibility.',
  'partner.conflict': 'Nothing was saved. The code is already reserved or this partner changed since the form was opened. Reload and review before saving.',
  'partner.pickupError': 'Nothing was saved. Choose distinct pickup options from the configured list.',
  'partner.pricingError': 'Nothing was saved. All sold services must use formula pricing before partner benefits can be assigned.',
  'partner.floorError': 'Nothing was saved. Configure a positive payment minimum for this currency and ensure every offered tour meets it, including any test tour. Free tours are not supported.',
  // Shared
  'common.reference': 'Reference',
  'common.service': 'Service',
  'common.date': 'Date',
  'common.quantity': 'People',
  'common.pickup': 'Pickup',
  'common.customer': 'Customer',
  'common.email': 'Email',
  'common.phone': 'Phone',
  'common.pickupAddress': 'Pickup address',
  'common.price': 'Total price',
  'common.status': 'Status',
  'common.meetingPoint': 'Meeting point',
  // The only message key that ever names a pickup option: the implied meeting-point option, which
  // a config declaring `meetingPoints` alone never gets to label itself.
  'pickup.meetingPoint': 'Meeting point',
  'common.openInMaps': 'Open in Google Maps',
  'common.skipContent': 'Skip to content',
  // Heading and link label of the shared contact block (see ui/layout.ts).
  'common.contactTitle': 'Need help?',
  'common.whatsapp': 'WhatsApp',
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
  // Slot-picker and party-size copy shared by the manage page's reschedule picker and the
  // admin calendar. Named `widget.*` from when the reference booking widget was the only
  // consumer; that widget now carries its own catalog.
  'widget.person': '{n} person',
  'widget.quantityCount': '{n} people',
  'widget.date': 'Pick a date',
  'widget.time': 'Pick a time',
  'widget.loadingSlots': 'Checking availability…',
  'widget.noSlots': 'No times available for this date',
  'widget.closed': 'Closed',
  // {n} counts further bookings of the chosen party size, not seats, so the copy says bookings.
  'widget.limited': 'Room for {n} more bookings',
  'widget.limitedOne': 'Room for 1 more booking',
  // Confirmation page
  'confirmation.title': 'Booking confirmed',
  'confirmation.lead': 'Thank you — your booking is confirmed. A confirmation email is on its way.',
  // The lead once the 4-hour detail window has passed: a return visit, long after the email went out.
  'confirmation.summaryLead': 'This booking is confirmed.',
  'confirmation.detailsEmailed': 'Your booking is confirmed. Full details and a link to manage your booking were emailed to you.',
  'confirmation.whatsNextTitle': "What's next",
  'confirmation.whatsNextBody': 'Save your reference and arrive a few minutes early. If you chose a custom pickup, we will contact you to confirm the address.',
  'confirmation.addToCalendar': 'Add to calendar',
  'confirmation.addGoogle': 'Google Calendar',
  'confirmation.addIcs': 'Apple / Outlook (.ics)',
  'confirmation.pendingTitle': 'Confirming your payment…',
  'confirmation.pendingBody': 'This page updates automatically. It usually takes a few seconds.',
  // Announced in the pending page's live region by the served poller (not rendered without script).
  'confirmation.pollChecking': 'Still checking with the payment provider…',
  'confirmation.pollUpdated': 'Payment status updated — loading your booking…',
  'confirmation.pendingTimeoutTitle': 'Still waiting for the payment provider',
  'confirmation.pendingTimeoutBody': "We're still waiting for the payment provider. You'll get an email once it's confirmed.",
  'confirmation.checkAgain': 'Check again',
  'confirmation.failedTitle': "We couldn't take this payment",
  'confirmation.failedBody': "We couldn't confirm your payment and no booking was made. Any voucher or bank instructions you received are void; if a payment does go through it will be refunded. Contact us and we'll sort it out.",
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
  'manage.reschedulePolicy': 'You can reschedule online until {deadline}.',
  // Shown in place of the one action whose deadline has passed while the other is still open.
  'manage.cancelClosed': 'Online cancellation closed on {deadline}. Contact us if you need to cancel.',
  'manage.rescheduleClosed': 'Online rescheduling closed on {deadline}. Contact us if you need a different time.',
  'manage.cancelConfirm': 'Yes, cancel this booking',
  'manage.cancelled': 'This booking has been cancelled.',
  // The page a customer lands on right after cancelling (their link stops working at that moment).
  'manage.cancelDoneTitle': 'Booking cancelled',
  'manage.cancelDoneBody': 'Your booking {reference} has been cancelled.',
  'manage.cancelDoneRefund': 'Any refund due is returned to your original payment method.',
  'manage.bookAgain': 'Book again',
  'manage.rescheduleTitle': 'Reschedule',
  'manage.rescheduleHint': 'Choose a new start time. Your price and party size stay the same.',
  'manage.newStart': 'New start',
  'manage.rescheduleSubmit': 'Reschedule booking',
  'manage.rescheduled': 'Booking rescheduled — the updated time is shown below.',
  'manage.pastCutoff': 'The change deadline for this booking has passed. Contact us if you need help.',
  'manage.errorSlotTaken': 'That time is no longer available — it may have just been booked. Please pick another time.',
  'manage.errorNotChangeable': 'This booking can no longer be changed.',
  // A cancel whose refund failed: the slot IS freed, only the money is still on its way, so this
  // reads as an outcome rather than as "nothing happened".
  'manage.cancelledRefundPending': 'Booking cancelled. The refund could not be issued automatically and will be handled by us.',
  'manage.errorInvalidInput': 'Check the values in the form and try again — nothing was changed.',
  'manage.errorConflict': 'Another change to this booking is still being processed. Wait a moment and reload this page.',
  'manage.errorInvalidLink': 'This link is no longer valid for that action. Use the link from your confirmation email, or contact us.',
  'manage.actionFailed': 'Something went wrong and nothing was changed. Please try again in a minute.',
  'manage.refund': 'Refund',
  'manage.refundNone': 'No refund',
  'manage.refundFull': 'Full refund',
  'manage.refundPartial': 'Partial refund',
  'manage.refundAmount': 'Partial refund amount',
  'manage.refundAmountHint': 'Only used when "Partial refund" is selected. Up to {max}.',
  'manage.noShowSubmit': 'Mark as no-show',
  'manage.noShowWarning': 'This marks the booking as missed by the customer and cannot be undone.',
  'manage.operatorBadge': 'Operator view',
  'manage.invalidTitle': 'Link not valid',
  'manage.invalidBody': 'This booking link is invalid or has expired. Use the exact link from your confirmation email, or contact us.',
  'manage.invalidUseEmailLink': 'Open your booking with the "Manage my booking" link in your confirmation email — it is the only way in. If you no longer have the email, contact us and we will resend it.',
  // Admin
  'admin.title': 'Dashboard',
  // The tab id stays `upcoming` in URLs; the Upcoming/Past split now lives in the list's own toolbar.
  'admin.tabUpcoming': 'Bookings',
  'admin.tabAvailability': 'Availability',
  'admin.tabAttention': 'Attention',
  // The overview of fields shown as tags (a partner, a channel): its tab when several fields share
  // it, the link column, the two count columns and what the counts include.
  'admin.tabTags': 'Tags',
  'admin.tagLink': 'Link',
  'admin.tagCopyLink': 'Copy link',
  'admin.tagUpcoming': 'Upcoming',
  'admin.tagPast': 'Past',
  'admin.tagCountsHint': 'Upcoming counts confirmed bookings still ahead. Past counts confirmed and no-show bookings whose start has passed. Open a count to see its bookings.',
  'admin.attentionCountOne': '1 issue needs attention',
  'admin.attentionCount': '{n} issues need attention',
  // The banner's one-incident form names the booking it is about: "ECT-2026-003, Mon 28 Sep at 1:00 PM".
  'admin.bannerBooking': '{reference}, {when}',
  'admin.bannerReview': 'Review',
  // The strip of totals above the tabs.
  'admin.glanceToday': 'Today',
  'admin.glanceTomorrow': 'Tomorrow',
  'admin.glanceWeek': 'Next 7 days',
  'admin.glanceHolds': 'Awaiting payment',
  'admin.glanceNext': 'Next at {time}',
  'admin.glanceDone': 'No departures left',
  'admin.glanceNothing': 'Nothing booked',
  'admin.glanceFirst': 'First at {time}',
  'admin.glanceBusiest': 'Busiest: {day}',
  'admin.glanceHoldsExpire': 'Oldest expires {time}',
  'admin.glanceHoldsNone': 'Nothing pending',
  'admin.legendBooked': 'Has bookings',
  'admin.legendLoad': 'Busiest moment',
  'admin.legendFull': 'Full',
  // A day's load: the most capacity units in use at any one moment, then how many bookings start
  // that day. `{bookings}` is one of the two count keys below.
  'admin.dayLoad': '{peak}/{capacity} peak · {bookings}',
  'admin.bookingCountOne': '{n} booking',
  'admin.bookingCount': '{n} bookings',
  'admin.dayOpen': 'Show this day’s bookings',
  // The day card's badge and load line. `{reason}` is the operator's own note on a closed day.
  'admin.dayOpenBadge': 'Open · capacity {n}',
  'admin.dayAdjustedBadge': 'Capacity {n} · default {d}',
  'admin.dayClosedBadge': 'Closed',
  'admin.dayClosedReason': 'Closed · {reason}',
  'admin.dayPeak': 'Busiest moment: {peak} of {capacity}',
  // Day-group headings in the bookings list count what is not going ahead separately.
  'admin.dayCancelled': '{n} cancelled',
  'admin.dayExpired': '{n} expired',
  'admin.bookedOn': 'Booked',
  'admin.searchLabel': 'Search bookings',
  'admin.navigation': 'Admin navigation',
  'admin.navOverview': 'Dashboard',
  'admin.noBookings': 'No upcoming bookings.',
  'admin.noPastBookings': 'No past bookings.',
  'admin.noMatchingBookings': 'No bookings match the filters.',
  'admin.pageRange': 'Showing {from}–{to} of {total}',
  'admin.pagination': 'Booking pages',
  'admin.pagePrev': 'Previous',
  'admin.pageNext': 'Next',
  'admin.searchTruncated': 'The search only looked at the first {n} bookings in this period. Add a status filter to narrow it.',
  'admin.capacity': 'Capacity',
  'admin.dayCapacity': 'Capacity for this day',
  'admin.stepDown': 'Decrease',
  'admin.stepUp': 'Increase',
  'admin.stateOverride': 'Adjusted',
  'admin.reason': 'Reason',
  'admin.reasonOptional': 'Reason (optional)',
  'admin.overrideTitle': 'Adjust one day',
  'admin.overrideTo': 'To date (optional)',
  'admin.selectHint': 'Drag or Shift-click for a range, Ctrl/⌘-click to add days. From the keyboard, Shift or Ctrl with Space.',
  // Shown instead of the key above on a touch screen, where there is no Shift or Ctrl to hold.
  'admin.selectHintTouch': 'Drag across days to select a range.',
  'admin.selectedDays': '{n} days selected',
  'admin.close': 'Close this day',
  'admin.closeMany': 'Close {n} days',
  'admin.reopen': 'Reopen day',
  'admin.reopenHint': 'Reopens with the default capacity of {n}.',
  'admin.dayNoBookings': 'No bookings on this day.',
  'admin.today': 'Today',
  'admin.prevMonth': 'Previous month',
  'admin.nextMonth': 'Next month',
  'admin.save': 'Save',
  'admin.clear': 'Reset to default ({n})',
  'admin.clearMany': 'Reset {n} days to default',
  'admin.defaultTitle': 'Schedule a capacity change',
  'admin.defaultHint': 'Use when capacity changes from a specific date, like a unit becoming unavailable. This overrides the normal capacity. Individually adjusted days keep their own value.',
  'admin.defaultScheduled': '{n} scheduled',
  'admin.monthFlagged': '{n} adjusted',
  'admin.calendarEarlier': 'Earlier months',
  'admin.calendarLater': 'Later months',
  'admin.defaultFrom': 'From date',
  'admin.defaultEntry': '{n} from {date}',
  'admin.remove': 'Remove',
  // Service, pickup and metadata match as well; the placeholder names what an operator types most.
  'admin.searchPlaceholder': 'Search name, email, phone or reference',
  // Filter options name a set of bookings, so they are worded apart from the per-row status badges
  // (a plural in Portuguese, for one).
  'admin.whenLabel': 'Period',
  'admin.whenUpcoming': 'Upcoming',
  'admin.whenPast': 'Past',
  // The list's default: what is going ahead or may yet. Cancelled and expired rows sit under All.
  'admin.filterActive': 'Active',
  'admin.filterAll': 'All',
  'admin.filterConfirmed': 'Confirmed',
  'admin.filterHold': 'Awaiting payment',
  'admin.filterExpired': 'Expired',
  'admin.filterCancelled': 'Cancelled',
  'admin.filterNoShow': 'No-show',
  'admin.manage': 'Manage',
  'admin.manageBooking': 'Manage booking',
  // `{n}` is the party size a pricing tier covers, for a service that sells places "up to" a size.
  'admin.guestsUpTo': 'Up to {n}',
  // The headcount the payer typed at checkout. Admin-owned rather than reusing widget.quantityCount,
  // which a site selling "up to N" tiers overrides to say "up to" — wrong for an exact number.
  'admin.guestCount': '{n} guests',
  'admin.guestCountOne': '1 guest',
  'admin.holdUntil': 'until {time}',
  // What happened to a booking's money after payment: a badge beside the status, and the matching
  // fact in the row's disclosure. `{amount}` is the running refund total; `{date}` is the day the
  // dispute opened.
  'admin.refundedBadge': 'Refunded {amount}',
  'admin.disputeOpen': 'Dispute open',
  'admin.disputeWon': 'Dispute won',
  'admin.disputeLost': 'Dispute lost',
  'admin.refunded': 'Refunded',
  'admin.dispute': 'Dispute',
  'admin.disputeOpenSince': 'Open since {date}',
  'admin.disputeWonOpened': 'Won (opened {date})',
  'admin.disputeLostOpened': 'Lost (opened {date})',
  'admin.copyReference': 'Copy reference',
  'admin.copyEmail': 'Copy email',
  'admin.copied': 'Copied',
  // Shown instead of a manage-link href when the booking's operatorToken isn't presentable — a
  // not-yet-backfilled legacy row, or no encryption key configured at all.
  'admin.manageUnavailable': 'Manage link unavailable',
  'admin.clearFilters': 'Clear filters',
  // A rejected admin form comes back to the page it was sent from with one of these.
  'admin.errorGeneric': 'Something went wrong and nothing was changed. Please try again.',
  'admin.errorInvalid': 'Nothing was saved: a value is missing or not valid.',
  'admin.errorInvalidField': 'Nothing was saved: check “{field}”.',
  'admin.errorExpired': 'This page expired. Please try again.',
  'admin.errorNotFound': 'That item no longer exists, so nothing was changed.',
  // Admin settings page
  'admin.settings': 'Settings',
  'admin.saved': 'Saved. Changes reach the public site within a minute.',
  'admin.sectionPolicy': 'Booking policy',
  'admin.sectionPolicyHint': 'The rules customers book, cancel and reschedule under.',
  'admin.sectionHours': 'Opening hours',
  'admin.sectionHoursHint': 'The first and last departure customers can book.',
  'admin.sectionPricing': 'Pricing',
  'admin.sectionPricingHint': 'What each service costs. Bookings already in checkout keep the price they were quoted.',
  'admin.sectionCapacity': 'Capacity',
  'admin.sectionCapacityHint': 'Set how many concurrent bookings are normally available.',
  'admin.sectionContact': 'Business & contact',
  'admin.sectionContactHint': 'Shown to customers on booking pages and emails.',
  'admin.sectionLegal': 'Legal',
  'admin.sectionLegalHint': 'Documents linked from the booking flow.',
  'admin.sectionReadonly': 'Deploy-time settings',
  'admin.readonlyHint': 'These cannot be changed here. Edit the site’s Reserva config file and redeploy.',
  // Recent changes: what the admin_change_history table recorded, one sentence per change.
  'admin.sectionHistory': 'Recent changes',
  'admin.historyHint': 'The latest changes made here to settings and capacity, newest first.',
  'admin.historyEmpty': 'No changes have been made here yet.',
  'admin.historyWhen': 'When',
  'admin.historyWho': 'Who',
  'admin.historyWhat': 'Change',
  // The admin sign-in exposed no identity for the change (e.g. a custom adminAuth without one).
  'admin.historyUnknownActor': 'Unknown',
  'admin.historySettingSet': '{item} set to {v}',
  'admin.historySettingReset': '{item} reset to default',
  'admin.historyDaySet': 'Capacity on {date} set to {n}',
  'admin.historyDayClosed': '{date} closed',
  'admin.historyDayCleared': 'Capacity on {date} reset to default',
  'admin.historyDefaultSet': 'Capacity from {date} set to {n}',
  'admin.historyDefaultRemoved': 'Scheduled capacity change from {date} removed',
  'admin.modified': 'Modified',
  'admin.modifiedCount': '{n} modified',
  'admin.unsaved': 'Not saved yet',
  'admin.unsavedCountOne': '1 unsaved change',
  'admin.unsavedCount': '{n} unsaved changes',
  'admin.noUnsaved': 'No unsaved changes',
  'admin.discard': 'Discard',
  'admin.pricePeople': 'Up to {n} people',
  'admin.pricePartySize': 'Party size',
  'admin.price': 'Price',
  'admin.default': 'Default: {v}',
  'admin.resetField': 'Reset',
  'admin.resetSection': 'Reset section to defaults',
  'admin.on': 'On',
  'admin.off': 'Off',
  'admin.none': 'None',
  'settingGroup.window': 'Booking window',
  'settingGroup.changes': 'Cancellation & rescheduling',
  'settingGroup.holds': 'Checkout holds & availability',
  'settingGroup.reminders': 'Reminders',
  'settingGroup.scheduleRuleSeason': '{service} · {from} – {to}',
  'settingGroup.everyDay': 'Every day',
  'settingGroup.sharedHours': 'All services',
  'settingGroup.surcharges': 'Pick-up surcharges · all services',
  'settingGroup.units': 'Group size · all services',
  'settingGroup.overrides': 'Service-specific overrides ({n})',
  'settingGroup.overridesHint': 'Values a service sets for itself in config, instead of following the shared block above.',
  'setting.firstStart': 'First departure',
  'setting.firstStart.hint': 'Earliest start time offered on the days this rule covers.',
  'setting.lastStart': 'Last departure',
  'setting.lastStart.hint': 'Latest start time offered. The booking still runs for the service’s full duration after it.',
  'setting.lastEnd': 'Closing time',
  'setting.lastEnd.hint': 'The last booking must be finished by this time; each service’s last departure follows from it.',
  'setting.lastDeparture': 'Last departure {time}, derived from the closing time and the service’s duration.',
  // A `.unit` key sits inside the number input as a suffix, so the label no longer carries it. A
  // `{v}` in a `.hint` is replaced by the field's current value and kept live as it is edited.
  'setting.intervalMin': 'Departure interval',
  'setting.intervalMin.unit': 'minutes',
  'setting.intervalMin.hint': 'Start times are offered every {v} minutes.',
  'setting.days': 'Days offered',
  'setting.priceTier': 'Up to {n} · {pickup}',
  'setting.priceTierNoPickup': 'Up to {n}',
  'setting.basePrice': 'Base price per unit',
  'setting.basePrice.hint': 'Charged once per capacity unit the party needs (a vehicle, a table).',
  'setting.surcharge': '{pickup} surcharge',
  'setting.maxUnits': 'Max units per booking',
  'setting.maxUnits.unit': 'units',
  'setting.maxUnits.hint': 'How many capacity units one booking may take; the largest party is units × seats.',
  'setting.surchargePerUnit': 'Surcharge charged per unit',
  'setting.surchargePerUnit.hint': 'On: a party that needs two units pays the surcharge twice. Off: once per booking.',
  'setting.minNoticeHours': 'Minimum notice',
  'setting.minNoticeHours.unit': 'hours',
  'setting.minNoticeHours.hint': 'New bookings close {v} hours before the start.',
  'setting.maxHorizonDays': 'Booking horizon',
  'setting.maxHorizonDays.unit': 'days',
  'setting.maxHorizonDays.hint': 'Customers can book up to {v} days ahead.',
  'setting.holdMinutes': 'Payment hold',
  'setting.holdMinutes.unit': 'minutes',
  'setting.holdMinutes.hint': 'An unpaid checkout keeps its spot for {v} minutes.',
  'setting.cancelCutoffHours': 'Cancellation cutoff',
  'setting.cancelCutoffHours.unit': 'hours',
  'setting.cancelCutoffHours.hint': 'Customers can cancel until {v} hours before the start.',
  'setting.rescheduleEnabled': 'Allow customers to reschedule',
  'setting.rescheduleCutoffHours': 'Reschedule cutoff',
  'setting.rescheduleCutoffHours.unit': 'hours',
  'setting.rescheduleCutoffHours.hint': 'Customers can move a booking until {v} hours before the start.',
  'setting.limitedThreshold': 'Low-availability warning',
  'setting.limitedThreshold.unit': 'left',
  'setting.limitedThreshold.hint': 'Show “room for N more bookings” once that many or fewer still fit. 0 turns it off.',
  'setting.maxHoldsPerIp': 'Max holds per visitor',
  'setting.maxHoldsPerIp.unit': 'holds',
  'setting.maxHoldsPerIp.hint': 'Stops one visitor reserving many spots with unpaid checkouts. Leave empty for no limit.',
  'setting.reminderHoursBefore': 'Reminder email',
  'setting.reminderHoursBefore.unit': 'hours before',
  'setting.reminderHoursBefore.hint': 'Sends customers a reminder {v} hours before the start. 0 turns reminders off.',
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
  // Operator incident cards on the admin page.
  'admin.incidentsNone': 'Nothing needs attention right now.',
  'admin.incidentSeverityDelayed': 'Delayed',
  'admin.incidentSeverityActionRequired': 'Needs action',
  'admin.incidentAttemptsOne': '{n} attempt',
  'admin.incidentAttempts': '{n} attempts',
  // `{when}` is a relative time ("12 minutes ago"); the exact date sits in the element's tooltip.
  'admin.incidentDetected': 'Detected {when}',
  'admin.incidentDetails': 'Technical details',
  'admin.openBooking': 'Open booking',
  // One sentence per incident kind: what the operator should actually do about it.
  'admin.incidentTodo.confirmation_email': 'The customer may not have their confirmation. Try again, or send them the booking details yourself.',
  'admin.incidentTodo.customer_notification': 'The customer was not told about a change to their booking. Try again, or contact them directly.',
  'admin.incidentTodo.calendar': 'Your calendar does not show this change yet. Try again, or update the calendar by hand.',
  'admin.incidentTodo.operations_sync': 'Your operations system did not receive this change. Try again, or enter it there by hand.',
  'admin.incidentTodo.refund': 'The refund did not go through. Check the payment with your payment provider and refund it there if needed.',
  'admin.incidentTodo.oversell': 'Two checkouts finished for the last place on this departure. Check whether it can take everyone; if not, move or cancel one booking and let the customer know.',
  'admin.incidentTodo.payment_verification_rejected': 'The payment could not be verified, so no booking was confirmed. Check it with your payment provider and contact the customer if they were charged.',
  'admin.incidentTodo.reconciliation_stale': 'The background job that retries failed steps has stopped running. Check that the site’s scheduled worker (cron trigger) is deployed.',
  'admin.incidentRetry': 'Try again',
  'admin.incidentRetryDuplicateWarning': 'This may send a duplicate to the customer if the original attempt actually went through.',
  'admin.incidentNoRetry': 'This needs manual handling — no automatic retry is available.',
  'admin.incidentResolveNoteLabel': 'What did you do?',
  'admin.incidentResolveNoteHint': 'Required, 1-500 characters. Recorded against your Access account and this incident only — it never changes the underlying booking.',
  'admin.incidentResolveSubmit': 'Mark as resolved',
  'admin.incidentRetryFailed': 'The retry ran but did not succeed. It will keep retrying automatically.',
  'admin.incidentRetryNotAvailable': 'This cannot be retried automatically.',
  'admin.incidentResolved': 'Marked as handled.',
  'admin.incidentHistory': 'Resolved in the last 30 days',
  'admin.incidentHistoryNone': 'Nothing has been resolved in the last 30 days.',
  'admin.incidentHistoryAutomatic': 'Resolved automatically',
  'admin.incidentHistoryManual': 'Resolved manually by {who}',
  'admin.incidentCounts30d': '{resolved} resolved · {opened} opened',
  'admin.incidentsTruncated': 'Showing the first {shown} of {total} open incidents.',
  'admin.securityCsrfOff': 'Admin form protection is off: set the RESERVA_CSRF_SECRET secret on this deployment.',
  'admin.securityTokenEncOff': 'Booking tokens are stored unencrypted: set the RESERVA_TOKEN_ENC_KEY secret on this deployment.',
} as const;

export type ReservaMessageKey = keyof typeof defaultMessages;
export type ReservaMessages = Record<ReservaMessageKey, string>;

// A generic library must not default to Portuguese; deployments set config.locales.default, so
// this only matters for a caller of resolveMessages/the components with no locale argument at all.
export const defaultLocale = 'en';

const portuguesePortugalMessages: ReservaMessages = portuguesePortugalCatalog;
const bundledCatalogs: Record<string, ReservaMessages> = {
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
// Every render resolved the full catalog again by copying several hundred strings; the answer only
// changes with the config object and locale, so it is kept per pair. Callers only read it.
const resolvedByConfig = new WeakMap<object, Map<string, ReservaMessages>>();
const resolvedWithoutConfig = new Map<string, ReservaMessages>();

export function resolveMessages(config: ResolvedClientConfig | undefined, locale: string | undefined): ReservaMessages {
  const key = locale ?? '';
  let byLocale = config ? resolvedByConfig.get(config) : resolvedWithoutConfig;
  const cached = byLocale?.get(key);
  if (cached) return cached;
  const resolved = buildMessages(config, locale);
  if (!byLocale) {
    byLocale = new Map();
    if (config) resolvedByConfig.set(config, byLocale);
  }
  byLocale.set(key, resolved);
  return resolved;
}

function buildMessages(config: ResolvedClientConfig | undefined, locale: string | undefined): ReservaMessages {
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
  return merged as ReservaMessages;
}

export function formatMessage(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}
