import { z } from 'astro/zod';
import { CURRENCY_CODE_PATTERN } from './currency';
import {
  BOOKING_EVENT_SUBSCRIBER_NAME_PATTERN,
  invalidSubscriberNameMessage,
  isBookingEvent,
  unknownBookingEventsMessage,
  type BookingEvent,
} from './events';

// A plain string because the pickup axis is whatever ids a service declares in
// ServiceConfig.pickupOptions (below), which no static union can enumerate. Kept as a named export
// (rather than inlining `string` everywhere) so call sites read as "the pickup axis" and so a
// future narrowing wouldn't need to touch every signature again.
export type PickupType = string;

export interface ScheduleRule {
  from?: string;
  to?: string;
  days: number[];
  firstStart: string;
  lastStart: string;
  intervalMin: number;
}

export interface PricingRule {
  maxQuantity: number;
  pickup: PickupType;
  priceMinor: number;
}

export interface MeetingPoint {
  id: string;
  label: string;
  mapsUrl: string;
}

// Plan 018 (design decision 1): a service-declared pickup option — the unit the pricing axis's
// `pickup` column now points at. `requiresAddress` is what gates Stripe's custom_fields address
// collection (stripe.ts); `usesMeetingPoint` is what plan 017's meeting-point requirement now
// re-keys off instead of `pickupType === 'default'`, so an option like Maze's "custom drop-off"
// can still start at a meeting point. `label`/`hint` are config-provided plain strings, like
// `meetingPoint.label` — absent on the `default`/`custom` ids falls back to the existing
// message-catalog keys so current widgets keep their translated copy (handlers/widget lane).
export interface PickupOption {
  id: string;
  label?: string;
  hint?: string;
  requiresAddress: boolean;
  usesMeetingPoint: boolean;
}

// Plan 018 (design decision 1): the pair every service behaved as before this plan — injected by
// validateConfig when a service declares no pickupOptions, and by pickupOptionFor for raw
// (never-validated) services, so both paths agree without either hard-coding the pair twice.
export const DEFAULT_PICKUP_OPTIONS: PickupOption[] = [
  { id: 'default', requiresAddress: false, usesMeetingPoint: true },
  { id: 'custom', requiresAddress: true, usesMeetingPoint: false },
];

export interface ServiceConfig {
  // Customer-facing display name used in emails ("Your Alfama Discovery is confirmed");
  // absent falls back to the service slug.
  title?: string;
  durationMin: number;
  turnaroundMin: number;
  schedule: ScheduleRule[];
  pricing: PricingRule[];
  occupancyFor?: (quantity: number) => number;
  // Plan 017 (design decision 1): exactly one of meetingPoint (single-point shorthand) or
  // meetingPoints (multi-point) may be declared — validateConfig rejects both/neither and
  // normalizes whichever is given into the canonical meetingPoints array below (clearing the
  // shorthand, so it never survives validation), and every internal reader goes through
  // resolveMeetingPoint instead of branching on which shape a service used.
  meetingPoint?: {
    label: string;
    mapsUrl: string;
  };
  meetingPoints?: MeetingPoint[];
  // Plan 018 (design decision 1): absent ⇒ validateConfig injects DEFAULT_PICKUP_OPTIONS, so an
  // existing config without this field validates and behaves identically.
  pickupOptions?: PickupOption[];
}

export interface WebhookEndpointConfig {
  name: string;
  url: string;
  // Must also be listed in the runtime's `secretBindings` for bookkit to be allowed to read it.
  secretBinding: string;
  // Defaults to every event in BOOKING_EVENTS.
  events?: BookingEvent[];
}

export interface ClientConfig {
  business: {
    name: string;
    shortCode: string;
    url: string;
    timezone: string;
    // Any ISO 4217 alphabetic code, lowercase (see core/currency.ts). Prices are stored in this
    // currency's minor unit; the configured payment provider validates its own narrower set.
    currency: string;
    contact: {
      email: string;
      phone: string;
      // A second phone line, shown alongside `phone` wherever contact details render.
      phoneSecondary?: string;
      whatsapp?: string;
    };
  };
  capacity: {
    default: number;
  };
  admin: {
    accessTeamDomain: string;
    accessAud: string;
    // Operator copy can differ from the locale used for customer pages, emails, and checkout.
    locale?: string;
  };
  services: Record<string, ServiceConfig>;
  booking: {
    minNoticeHours: number;
    maxHorizonDays: number;
    holdMinutes: number;
    cancelCutoffHours: number;
    reschedule: {
      enabled: boolean;
      cutoffHours: number;
    };
    limitedThreshold: number;
    calendarMaxStaleSeconds: number;
    maxHoldsPerIp?: number;
    // BK-SEC-002: manage/operator token lifetime, counted from booking end (not creation) so a
    // link keeps working through the whole pre-service period plus a post-service grace window
    // (late reschedules, refund follow-up, review requests). Optional — defaults to
    // DEFAULT_TOKEN_EXPIRY_DAYS below when unset, so existing deployments don't need a config
    // change to pick up expiry.
    tokenExpiryDays?: number;
  };
  locales: {
    supported: string[];
    default: string;
  };
  legal: {
    termsUrl: string;
  };
  // Plan 021 (design decision 2): outbound signed webhook endpoints. `url` is ordinary config; the
  // signing key is a Worker secret referenced by binding name, so it never lives in the config file
  // a consumer commits. Names follow the same domain as in-process hook names, and a hook and a
  // webhook may share one: outbox rows tell them apart by their `family` column, not by a
  // qualified key.
  webhooks?: WebhookEndpointConfig[];
  ui?: {
    // Per-locale overrides for Bookkit's rendered copy, merged over its bundled catalog and
    // English fallback. Keys are locale tags ('pt-PT', 'fr', …); values are partial message maps.
    messages?: Record<string, Record<string, string>>;
  };
  emails?: {
    // Forces every outgoing email into one locale regardless of the language the customer booked
    // in. Absent keeps the per-booking locale (with the usual supported/default fallback).
    locale?: string;
    // Visual identity for the branded email shell. All optional — a client without branding gets
    // a neutral dark header with the business name as text.
    branding?: {
      logoUrl?: string;
      // Rendered size of the logo <img>; explicit dimensions because some desktop clients
      // (Outlook) otherwise paint the image at its natural pixel size.
      logoWidth?: number;
      logoHeight?: number;
      headerBackground?: string;
      accentColor?: string;
      cardBackground?: string;
    };
    // Per-locale overrides for email copy, merged over the bundled catalog exactly like
    // ui.messages is for widget copy.
    messages?: Record<string, Record<string, string>>;
  };
}

export function adminLocaleFor(config: ClientConfig): string {
  return config.admin.locale ?? config.locales.default;
}

// BK-SEC-002: default for booking.tokenExpiryDays when a deployment doesn't set one — long
// enough to cover post-service reschedules/refund disputes/review-request follow-ups without ever
// being effectively unlimited.
export const DEFAULT_TOKEN_EXPIRY_DAYS = 60;

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const monthDayPattern = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const scheduleSchema = z.object({
  from: z.string().regex(monthDayPattern).optional(),
  to: z.string().regex(monthDayPattern).optional(),
  days: z.array(z.number().int().min(0).max(6)).min(1),
  firstStart: z.string().regex(timePattern),
  lastStart: z.string().regex(timePattern),
  intervalMin: z.number().int().positive(),
});

// Plan 018 (design decision 1): slug-safe so an id can be used verbatim as a `data-` attribute
// value, a widget radio input's `value`, and a URL-safe checkout body field without escaping.
const pickupOptionIdPattern = /^[a-z0-9_-]+$/;

const pickupOptionSchema = z.object({
  id: z.string().min(1).regex(pickupOptionIdPattern),
  label: z.string().min(1).optional(),
  hint: z.string().min(1).optional(),
  requiresAddress: z.boolean(),
  usesMeetingPoint: z.boolean(),
});

const serviceSchema = z.object({
  title: z.string().min(1).optional(),
  durationMin: z.number().int().positive(),
  turnaroundMin: z.number().int().nonnegative(),
  schedule: z.array(scheduleSchema).min(1),
  pricing: z.array(z.object({
    maxQuantity: z.number().int().positive(),
    // A plain zod enum can't express a per-service id set, so validateService checks each row's pickup
    // against the service's own declared option ids (default/custom when none are declared).
    pickup: z.string().min(1),
    priceMinor: z.number().int().nonnegative(),
  })).min(1),
  occupancyFor: z.custom<(quantity: number) => number>((value) => typeof value === 'function').optional(),
  meetingPoint: z.object({ label: z.string().min(1), mapsUrl: z.string().url() }).optional(),
  meetingPoints: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    mapsUrl: z.string().url(),
  })).min(1).optional(),
  pickupOptions: z.array(pickupOptionSchema).min(1).optional(),
});

export const clientConfigSchema = z.object({
  business: z.object({
    name: z.string().min(1),
    shortCode: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,9}$/),
    url: z.string().url(),
    timezone: z.string().min(1),
    currency: z.string().regex(CURRENCY_CODE_PATTERN, 'must be a lowercase ISO 4217 alphabetic code (e.g. "eur", "jpy")'),
    contact: z.object({
      email: z.string().email(),
      phone: z.string().min(1),
      phoneSecondary: z.string().min(1).optional(),
      whatsapp: z.string().optional(),
    }),
  }),
  capacity: z.object({ default: z.number().int().nonnegative() }),
  admin: z.object({
    accessTeamDomain: z.string().refine(isValidAccessTeamDomain, 'must be an HTTPS Cloudflare Access origin'),
    accessAud: z.string().min(1),
    locale: z.string().min(1).refine(isValidLocale, 'must be a valid BCP 47 locale').optional(),
  }),
  services: z.record(z.string(), serviceSchema).refine((value) => Object.keys(value).length > 0, 'at least one service is required'),
  booking: z.object({
    minNoticeHours: z.number().nonnegative(),
    maxHorizonDays: z.number().int().positive(),
    holdMinutes: z.number().int().nonnegative(),
    cancelCutoffHours: z.number().nonnegative(),
    reschedule: z.object({ enabled: z.boolean(), cutoffHours: z.number().nonnegative() }),
    limitedThreshold: z.number().int().nonnegative(),
    calendarMaxStaleSeconds: z.number().int().min(60).default(15 * 60),
    maxHoldsPerIp: z.number().int().positive().optional(),
    tokenExpiryDays: z.number().int().positive().optional(),
  }),
  locales: z.object({
    supported: z.array(z.string().min(1)).min(1),
    default: z.string().min(1),
  }),
  legal: z.object({ termsUrl: z.string().url() }),
  webhooks: z.array(z.object({
    name: z.string(),
    url: z.string().url(),
    secretBinding: z.string().min(1),
    events: z.array(z.string()).min(1).optional(),
  })).optional(),
  ui: z.object({
    messages: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  }).optional(),
  emails: z.object({
    locale: z.string().min(1).refine(isValidLocale, 'must be a valid BCP 47 locale').optional(),
    branding: z.object({
      logoUrl: z.string().url().optional(),
      logoWidth: z.number().int().positive().optional(),
      logoHeight: z.number().int().positive().optional(),
      headerBackground: z.string().min(1).optional(),
      accentColor: z.string().min(1).optional(),
      cardBackground: z.string().min(1).optional(),
    }).optional(),
    messages: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  }).optional(),
});

function addIssue(ctx: { addIssue: (issue: { code: 'custom'; path: (string | number)[]; message: string }) => void }, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: 'custom', path, message });
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function isValidLocale(locale: string): boolean {
  try {
    Intl.getCanonicalLocales(locale);
    return true;
  } catch {
    return false;
  }
}

function isValidAccessTeamDomain(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.endsWith('.cloudflareaccess.com')
      && url.port === ''
      && url.pathname === '/'
      && url.search === ''
      && url.hash === ''
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

function isValidMonthDay(value: string): boolean {
  const [month = 0, day = 0] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(2024, month - 1, day));
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function validateService(service: ServiceConfig, serviceSlug: string, add: (path: (string | number)[], message: string) => void): void {
  // Plan 018 (design decision 1): declared pickup option ids are the domain the pricing axis
  // below validates against — absent pickupOptions behaves exactly like the old fixed pair.
  const pickupOptions = service.pickupOptions ?? DEFAULT_PICKUP_OPTIONS;
  const pickupOptionIds = pickupOptions.map((option) => option.id);
  const pickupOptionIdSet = new Set(pickupOptionIds);
  if (service.pickupOptions) {
    const seenIds = new Set<string>();
    for (const [index, option] of service.pickupOptions.entries()) {
      if (seenIds.has(option.id)) {
        add(['services', serviceSlug, 'pickupOptions', index, 'id'], `duplicate pickup option id (${option.id}); ids must be unique within a service`);
      }
      seenIds.add(option.id);
    }
  }

  // Plan 018 (design decision 2): the duplicate-breakpoint map is keyed by declared option id
  // instead of the old two-literal Record, so it scales to however many options a service declares.
  const pricingBreakpoints = new Map<string, Map<number, number>>();
  for (const [index, rule] of service.pricing.entries()) {
    if (!pickupOptionIdSet.has(rule.pickup)) {
      add(
        ['services', serviceSlug, 'pricing', index, 'pickup'],
        `service ${serviceSlug} pricing rule ${index} references undeclared pickup option ${rule.pickup}; valid pickup option ids: ${pickupOptionIds.join(', ')}`,
      );
      continue;
    }
    let breakpoints = pricingBreakpoints.get(rule.pickup);
    if (!breakpoints) {
      breakpoints = new Map();
      pricingBreakpoints.set(rule.pickup, breakpoints);
    }
    const previousIndex = breakpoints.get(rule.maxQuantity);
    if (previousIndex !== undefined) {
      add(
        ['services', serviceSlug, 'pricing', index],
        `service ${serviceSlug} pricing rule ${index} (pickup=${rule.pickup}, maxQuantity=${rule.maxQuantity}) duplicates and shadows rule ${previousIndex}; remove or change one breakpoint`,
      );
    } else {
      breakpoints.set(rule.maxQuantity, index);
    }
  }

  for (const [index, rule] of service.schedule.entries()) {
    if (rule.from && !isValidMonthDay(rule.from)) {
      add(['services', serviceSlug, 'schedule', index, 'from'], 'must be a valid month-day');
    }
    if (rule.to && !isValidMonthDay(rule.to)) {
      add(['services', serviceSlug, 'schedule', index, 'to'], 'must be a valid month-day');
    }
    if (rule.firstStart > rule.lastStart) {
      add(['services', serviceSlug, 'schedule', index], 'firstStart must not be after lastStart');
    }
    if (rule.intervalMin > 24 * 60) {
      add(['services', serviceSlug, 'schedule', index, 'intervalMin'], 'intervalMin must be at most one day');
    }
  }

  const highest = Math.max(...service.pricing.map((row) => row.maxQuantity));
  const quantityValues = Array.from({ length: highest }, (_, index) => index + 1);
  // Plan 018 (design decision 2): iterates the service's declared option ids instead of the old
  // literal ['default', 'custom'] pair, so a per-id coverage hole is reported for every option a
  // service actually declares (Maze's four-option table gets a full coverage set per option, not
  // just two).
  for (const quantity of quantityValues) {
    for (const pickup of pickupOptionIds) {
      if (!service.pricing.some((row) => row.pickup === pickup && quantity <= row.maxQuantity)) {
        add(['services', serviceSlug, 'pricing'], `missing ${pickup} pricing for quantity=${quantity}`);
      }
    }
  }
  if (service.occupancyFor) {
    for (const quantity of quantityValues) {
      try {
        const units = service.occupancyFor(quantity);
        if (!Number.isInteger(units) || units < 1) {
          add(['services', serviceSlug, 'occupancyFor'], `occupancyFor(${quantity}) must return a positive integer`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        add(['services', serviceSlug, 'occupancyFor'], `occupancyFor(${quantity}) threw: ${message}`);
      }
    }
  }

  // Plan 017 (design decision 1): exactly one of meetingPoint/meetingPoints — two sources of
  // truth for where a service departs from would let them silently disagree.
  if (service.meetingPoint && service.meetingPoints) {
    add(['services', serviceSlug], 'declare either meetingPoint or meetingPoints, not both');
  } else if (!service.meetingPoint && !service.meetingPoints) {
    add(['services', serviceSlug], 'must declare either meetingPoint or meetingPoints');
  } else if (service.meetingPoints) {
    const seenIds = new Set<string>();
    for (const [index, point] of service.meetingPoints.entries()) {
      if (seenIds.has(point.id)) {
        add(['services', serviceSlug, 'meetingPoints', index, 'id'], `duplicate meeting point id (${point.id}); ids must be unique within a service`);
      }
      seenIds.add(point.id);
    }
  }
}

export function validateConfig(input: unknown): ClientConfig {
  const parsed = clientConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw parsed.error;
  }
  const config = parsed.data as ClientConfig;
  const issues: Array<{ path: (string | number)[]; message: string }> = [];
  const add = (path: (string | number)[], message: string): void => {
    issues.push({ path, message });
  };

  if (!isValidTimezone(config.business.timezone)) {
    add(['business', 'timezone'], 'must be a valid IANA timezone');
  }
  // Plan 022 (design decision 7): only the floor is a core rule — a hold shorter than the payment
  // session it guards can expire while that session is still payable, which oversells. Any upper
  // bound belongs to the payment provider that has to keep the session open, and it enforces it
  // through PaymentProvider.validateConfig (core/events.ts).
  if (config.booking.holdMinutes < 35) {
    add(['booking', 'holdMinutes'], 'must be at least 35 minutes, so a hold outlives the payment session it guards');
  }
  if (!config.locales.supported.includes(config.locales.default)) {
    add(['locales', 'default'], 'must be included in locales.supported');
  }
  for (const [index, locale] of config.locales.supported.entries()) {
    if (!isValidLocale(locale)) {
      add(['locales', 'supported', index], `locale ${locale} is not a valid BCP 47 locale tag`);
    }
  }
  for (const [slug, service] of Object.entries(config.services)) {
    validateService(service, slug, add);
  }
  // Plan 021 (design decision 1/2): the same closed-vocabulary check hooks get at startup, applied
  // to declared webhook endpoints during config validation — a typo'd event name fails the build
  // with the whole valid set in the message rather than silently never firing.
  const webhookNames = new Set<string>();
  for (const [index, endpoint] of (config.webhooks ?? []).entries()) {
    if (!BOOKING_EVENT_SUBSCRIBER_NAME_PATTERN.test(endpoint.name)) {
      add(['webhooks', index, 'name'], invalidSubscriberNameMessage(endpoint.name));
    } else if (webhookNames.has(endpoint.name)) {
      add(['webhooks', index, 'name'], `duplicate webhook name "${endpoint.name}"; names must be unique`);
    }
    webhookNames.add(endpoint.name);
    for (const [eventIndex, event] of (endpoint.events ?? []).entries()) {
      if (!isBookingEvent(event)) add(['webhooks', index, 'events', eventIndex], unknownBookingEventsMessage(event));
    }
  }

  if (issues.length > 0) {
    const result = clientConfigSchema.superRefine((_, ctx) => {
      for (const issue of issues) addIssue(ctx, issue.path, issue.message);
    }).safeParse(input);
    if (!result.success) throw result.error;
  }
  for (const service of Object.values(config.services)) {
    service.pricing.sort((a, b) => a.maxQuantity - b.maxQuantity);
    // Plan 017 (design decision 1): canonicalize the meetingPoint shorthand into meetingPoints —
    // the same canonicalize-on-validate move used above for pricing order — so every internal
    // reader only has to handle one shape (via resolveMeetingPoint below). The exactly-one-of
    // check above already guarantees meetingPoint is set whenever meetingPoints is absent here.
    // Clearing the shorthand afterwards keeps validateConfig idempotent on its own output: both
    // defineBookkitRuntime and defineCloudflareBookkitRuntime (runtime-context.ts) validate the
    // config once at definition time and pass that already-validated config back through
    // createBookkitContext (context.ts) on every request, which validates it again — without
    // clearing meetingPoint here, that second pass would see both fields and reject an
    // already-valid config as declaring both.
    if (!service.meetingPoints) {
      service.meetingPoints = [{ id: 'default', ...service.meetingPoint! }];
      delete service.meetingPoint;
    }
    // Plan 018 (design decision 1): inject the default option pair the same way meetingPoints'
    // shorthand is canonicalized above — a fresh copy (not the shared DEFAULT_PICKUP_OPTIONS
    // array) so nothing downstream can mutate the module-level default. Idempotent by
    // construction: once pickupOptions is set (either declared or injected here), re-validating
    // the already-validated config leaves it untouched — the same idempotency constraint plan 017
    // discovered for meetingPoints (defineBookkitRuntime validates once at definition,
    // createBookkitContext validates again per request).
    if (!service.pickupOptions) {
      service.pickupOptions = DEFAULT_PICKUP_OPTIONS.map((option) => ({ ...option }));
    }
  }
  return config;
}

export function quantityValuesForService(service: ServiceConfig): number[] {
  const highest = Math.max(...service.pricing.map((row) => row.maxQuantity), 0);
  return Array.from({ length: highest }, (_, index) => index + 1);
}

export function resolveService(config: ClientConfig, serviceSlug: string): ServiceConfig {
  const service = config.services[serviceSlug];
  if (!service) throw new Error(`Unknown service: ${serviceSlug}`);
  return service;
}

// Plan 017 (design decision 1): id match wins; no id or an unknown id falls back to the first
// declared point. Tolerant of a raw (never-validated) service — examples/smoke-site imports config
// directly for the widget (plan 017 STOP condition 2) — by deriving the single point from the
// meetingPoint shorthand when meetingPoints hasn't been normalized in yet.
export function resolveMeetingPoint(service: ServiceConfig, meetingPointId?: string): MeetingPoint {
  const points = service.meetingPoints ?? (service.meetingPoint ? [{ id: 'default', ...service.meetingPoint }] : []);
  if (points.length === 0) {
    throw new Error('service declares no meeting points');
  }
  if (meetingPointId) {
    const match = points.find((point) => point.id === meetingPointId);
    if (match) return match;
  }
  return points[0]!;
}

// Plan 018 (design decision 1): tolerant of a raw (never-validated) service, the same precedent as
// resolveMeetingPoint/meetingPointForBooking above (plan 017) — examples/smoke-site imports config
// directly for the widget, never through validateConfig, and the runtime path validates twice
// (defineBookkitRuntime at definition, createBookkitContext per request), so this must agree with
// validateConfig's injected default on an un-normalized service too. Returns undefined for an id the
// service hasn't declared (rather than falling back the way resolveMeetingPoint does) — callers
// each have a different reaction to an undeclared id: stripe's requiresAddress gate, handlers'
// checkout id validation (400 on undefined), and the admin/widget label fallback all need to know
// "not declared" is a real, distinct outcome, not silently redirected to the first option.
export function pickupOptionFor(service: ServiceConfig, id: string | null): PickupOption | undefined {
  if (id === null) return undefined;
  const options = service.pickupOptions ?? DEFAULT_PICKUP_OPTIONS;
  return options.find((option) => option.id === id);
}

// Plan 017 (design decision 3): per-booking rendering resolution, shared by the manage/
// confirmation payloads, brevo, calendar, and the admin table. Unlike resolveMeetingPoint's
// first-point fallback (checkout-time resolution against currently-declared points), a stored id
// that is NO LONGER declared falls back to the booking's stored label snapshot with no maps link
// — validateConfig cannot cross-check the DB, and an operator may remove a point that existing
// bookings still reference; sending those customers to the first (wrong) point would be worse
// than a label without a map. A NULL id is a pre-0014 row and keeps today's behavior (first/only
// declared point).
export function meetingPointForBooking(
  service: ServiceConfig,
  meetingPointId: string | null,
  meetingPointLabel: string | null,
): { label: string; mapsUrl: string | null } {
  if (meetingPointId) {
    const points = service.meetingPoints ?? (service.meetingPoint ? [{ id: 'default', ...service.meetingPoint }] : []);
    const match = points.find((point) => point.id === meetingPointId);
    if (match) return { label: match.label, mapsUrl: match.mapsUrl };
    return { label: meetingPointLabel ?? meetingPointId, mapsUrl: null };
  }
  const first = resolveMeetingPoint(service);
  return { label: first.label, mapsUrl: first.mapsUrl };
}
