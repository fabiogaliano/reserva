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
// ServiceConfig.location.pickupOptions (below), which no static union can enumerate. Kept as a
// named export (rather than inlining `string` everywhere) so call sites read as "the pickup axis"
// and so a future narrowing wouldn't need to touch every signature again.
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
  // Plan 023 (design decision 2): optional — a service with no `location` module has no pickup
  // axis at all, so its rules select by quantity tier alone. A service that declares `location`
  // still requires every rule to name a declared pickup option id (validateService).
  pickup?: PickupType;
  priceMinor: number;
}

export interface MeetingPoint {
  id: string;
  label: string;
  mapsUrl: string;
}

// Plan 018 (design decision 1): a service-declared pickup option — the unit the pricing axis's
// `pickup` column now points at. `requiresAddress` is what gates Stripe's custom_fields address
// collection (stripe.ts); `usesMeetingPoint` is what plan 017's meeting-point requirement re-keys
// off instead of `pickupType === 'default'`, so an option like Maze's "custom drop-off" can still
// start at a meeting point. `label`/`hint` are config-provided plain strings — absent falls back to
// the message-catalog keys for the `default`/`custom` ids so pre-existing widgets keep their copy.
export interface PickupOption {
  id: string;
  label?: string;
  hint?: string;
  requiresAddress: boolean;
  usesMeetingPoint: boolean;
}

// Plan 024 (design decision 1): a label (field label, option label) is either a plain string or a
// per-locale map resolved the same way config.ui.messages/config.emails.messages already are
// (candidate locale, then its base language, then the config's default locale/its base, then the
// first declared value) — see resolveMetadataFieldLabel below.
export type LocalizedText = string | Record<string, string>;

export interface MetadataFieldOption {
  value: string;
  label: LocalizedText;
}

// Plan 024 (design decision 1): the whole consumer-declared metadata DSL — four types, three
// optional modifiers. This is deliberately the entire language: no conditional fields, cross-field
// rules, custom validators, regex types, or a fifth type (the plan's STOP condition). `key` is the
// wire/storage key (validated against METADATA_FIELD_KEY_PATTERN); `maxLength` applies to `text`
// only (default 500, enforced at checkout — see handlers/checkout.ts).
export interface MetadataField {
  key: string;
  label: LocalizedText;
  type: 'text' | 'number' | 'boolean' | 'select';
  options?: MetadataFieldOption[];
  required?: boolean;
  maxLength?: number;
}

export interface ServiceConfig {
  // Customer-facing display name used in emails ("Your Alfama Discovery is confirmed");
  // absent falls back to the service slug.
  title?: string;
  durationMin: number;
  turnaroundMin: number;
  schedule: ScheduleRule[];
  pricing: PricingRule[];
  occupancyFor?: (quantity: number) => number;
  // Plan 023 (design decision 1): the whole pickup/meeting-point axis, opt-in per service. Absent
  // means the service has no location dimension anywhere — no pickup field in pricing, checkout,
  // emails, admin, or the calendar description. Declaring it requires at least one pickup option;
  // meetingPoints is optional within it (a service can collect only a custom address, with no
  // meeting-point choice at all). The v1 top-level `meetingPoint`/`meetingPoints`/`pickupOptions`
  // keys are gone — validateConfig rejects them with a message pointing here.
  location?: {
    meetingPoints?: MeetingPoint[];
    pickupOptions: PickupOption[];
  };
  // Plan 024 (design decision 1): the extension mechanism for anything business-specific that
  // isn't core and isn't location — dietary notes, skill level, table preference, etc. Absent means
  // the service accepts no metadata at all; checkout rejects a non-empty `metadata` body for it.
  metadataFields?: MetadataField[];
}

export interface WebhookEndpointConfig {
  name: string;
  url: string;
  // Must also be listed in the runtime's `secretBindings` for reserva to be allowed to read it.
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
    // Plan 025 (design decision 2-3): optional as a pair — present auto-selects Cloudflare Access
    // as the admin/ops auth implementation (cloudflareAccessAdminAuth, src/access.ts); absent means
    // the consumer must supply a custom `adminAuth` callback to the runtime instead. Exactly one of
    // the two is required whenever the admin or ops route group is enabled, checked once,
    // synchronously, at runtime-definition initialization (src/runtime-context.ts) — not here,
    // since this schema has no way to see a runtime-only `adminAuth` callback.
    access?: {
      teamDomain: string;
      aud: string;
    };
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
  // Plan 025 (design decision 3): moved here from the Astro-only `ReservaIntegrationOptions.routes`
  // so the same declared intent drives both route injection (the integration reads it during
  // astro:config:setup) and admin-auth selection (the runtime factory reads it at
  // runtime-definition initialization) — one shared declaration instead of two independent
  // options that could disagree. Both default to `true`; the public booking API and customer
  // manage routes are load-bearing and are never disableable here.
  routes?: {
    admin?: boolean;
    ops?: boolean;
    // Plan 027 (design decision 8): controls ONLY Reserva's built-in server-rendered
    // /booking/manage page. The manage/cancel/reschedule APIs stay mounted either way, so a
    // headless consumer can replace the page with its own UI; when this is false, every
    // library-owned link producer (default emails, the admin table) stops emitting links to it
    // rather than pointing at a route that isn't mounted.
    manage?: boolean;
  };
  ui?: {
    // Per-locale overrides for Reserva's rendered copy, merged over its bundled catalog and
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

const meetingPointSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  mapsUrl: z.string().url(),
});

// Plan 024 (design decision 1): the wire/storage key — lowercase, `_`-separated, capped at 32
// characters so it's safe to use verbatim as a JSON object key and a checkout body field.
export const METADATA_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

const localizedTextSchema = z.union([z.string().min(1), z.record(z.string(), z.string().min(1))]);

const metadataFieldOptionSchema = z.object({
  value: z.string().min(1),
  label: localizedTextSchema,
});

const metadataFieldSchema = z.object({
  key: z.string().regex(METADATA_FIELD_KEY_PATTERN),
  label: localizedTextSchema,
  type: z.enum(['text', 'number', 'boolean', 'select']),
  options: z.array(metadataFieldOptionSchema).min(1).optional(),
  required: z.boolean().optional(),
  maxLength: z.number().int().positive().optional(),
});

// Plan 023 (design decision 1): pickupOptions is required within a declared location (at least one
// entry) — a location with no pickup options is not expressible, matching "declaring it requires
// pickupOptions" in the plan's design decision. meetingPoints stays optional: a service can collect
// only a custom address, with no meeting-point choice at all.
const locationSchema = z.object({
  meetingPoints: z.array(meetingPointSchema).min(1).optional(),
  pickupOptions: z.array(pickupOptionSchema).min(1),
});

const serviceSchema = z.object({
  title: z.string().min(1).optional(),
  durationMin: z.number().int().positive(),
  turnaroundMin: z.number().int().nonnegative(),
  schedule: z.array(scheduleSchema).min(1),
  pricing: z.array(z.object({
    maxQuantity: z.number().int().positive(),
    // A plain zod enum can't express a per-service id set, so validateService checks each row's
    // pickup against the service's own declared location.pickupOptions ids (or rejects it outright
    // when the service declares no location at all).
    pickup: z.string().min(1).optional(),
    priceMinor: z.number().int().nonnegative(),
  })).min(1),
  occupancyFor: z.custom<(quantity: number) => number>((value) => typeof value === 'function').optional(),
  location: locationSchema.optional(),
  metadataFields: z.array(metadataFieldSchema).optional(),
  // Plan 023 (design decision 1): the v1 top-level keys. Kept in the schema as z.unknown() (rather
  // than omitted, which zod would just strip silently) purely so validateService below can detect
  // their presence and reject the config with a message pointing at the new `location` path.
  meetingPoint: z.unknown().optional(),
  meetingPoints: z.unknown().optional(),
  pickupOptions: z.unknown().optional(),
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
    access: z.object({
      teamDomain: z.string().refine(isValidAccessTeamDomain, 'must be an HTTPS Cloudflare Access origin'),
      aud: z.string().min(1),
    }).optional(),
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
  routes: z.object({
    admin: z.boolean().optional(),
    ops: z.boolean().optional(),
    manage: z.boolean().optional(),
  }).optional(),
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

// Plan 023 (design decision 1): the v1 top-level keys a service might still carry (present in the
// zod schema as z.unknown() precisely so this can see them) — each maps onto where it now lives
// under `location`, so the message tells the operator exactly what to move, not just that
// something is wrong.
const legacyLocationKeys: Array<{ key: 'meetingPoint' | 'meetingPoints' | 'pickupOptions'; movesTo: string }> = [
  { key: 'meetingPoint', movesTo: 'location.meetingPoints' },
  { key: 'meetingPoints', movesTo: 'location.meetingPoints' },
  { key: 'pickupOptions', movesTo: 'location.pickupOptions' },
];

function validateService(service: ServiceConfig, serviceSlug: string, add: (path: (string | number)[], message: string) => void): void {
  const raw = service as unknown as Record<string, unknown>;
  for (const { key, movesTo } of legacyLocationKeys) {
    if (raw[key] !== undefined) {
      add(['services', serviceSlug, key], `'${key}' is a v1 top-level key removed in v2; declare services.${serviceSlug}.${movesTo} instead (see the location-module migration guide)`);
    }
  }

  const location = service.location;
  const pickupOptions = location?.pickupOptions ?? [];
  const pickupOptionIds = pickupOptions.map((option) => option.id);
  const pickupOptionIdSet = new Set(pickupOptionIds);
  if (location) {
    const seenOptionIds = new Set<string>();
    for (const [index, option] of pickupOptions.entries()) {
      if (seenOptionIds.has(option.id)) {
        add(['services', serviceSlug, 'location', 'pickupOptions', index, 'id'], `duplicate pickup option id (${option.id}); ids must be unique within a service`);
      }
      seenOptionIds.add(option.id);
    }
    // Plan 023 (design decision 1): "a pickup option with usesMeetingPoint requires meeting
    // points" — previously guaranteed for free (every service had to declare a meeting point);
    // now that meetingPoints is optional within location, it needs an explicit check.
    const meetingPoints = location.meetingPoints ?? [];
    if (pickupOptions.some((option) => option.usesMeetingPoint) && meetingPoints.length === 0) {
      add(['services', serviceSlug, 'location', 'meetingPoints'], 'at least one pickup option has usesMeetingPoint: true, so location.meetingPoints must declare at least one point');
    }
    const seenPointIds = new Set<string>();
    for (const [index, point] of meetingPoints.entries()) {
      if (seenPointIds.has(point.id)) {
        add(['services', serviceSlug, 'location', 'meetingPoints', index, 'id'], `duplicate meeting point id (${point.id}); ids must be unique within a service`);
      }
      seenPointIds.add(point.id);
    }
  }

  // Plan 023 (design decision 2): the duplicate-breakpoint map is keyed by declared pickup id when
  // the service is location-ful, or a single '' key (tiers only) when it's location-less — the same
  // key convention resolvedPriceTableFor/pricingCombinations (core/pricing.ts) use.
  const pricingBreakpoints = new Map<string, Map<number, number>>();
  for (const [index, rule] of service.pricing.entries()) {
    if (location) {
      if (rule.pickup === undefined) {
        add(['services', serviceSlug, 'pricing', index, 'pickup'], `service ${serviceSlug} declares a location module, so pricing rule ${index} must declare 'pickup'; valid pickup option ids: ${pickupOptionIds.join(', ')}`);
        continue;
      }
      if (!pickupOptionIdSet.has(rule.pickup)) {
        add(
          ['services', serviceSlug, 'pricing', index, 'pickup'],
          `service ${serviceSlug} pricing rule ${index} references undeclared pickup option ${rule.pickup}; valid pickup option ids: ${pickupOptionIds.join(', ')}`,
        );
        continue;
      }
    } else if (rule.pickup !== undefined) {
      add(
        ['services', serviceSlug, 'pricing', index, 'pickup'],
        `service ${serviceSlug} has no location module (no services.${serviceSlug}.location), so pricing rule ${index} must not declare 'pickup'; remove it or add services.${serviceSlug}.location.pickupOptions`,
      );
      continue;
    }
    const breakpointKey = rule.pickup ?? '';
    let breakpoints = pricingBreakpoints.get(breakpointKey);
    if (!breakpoints) {
      breakpoints = new Map();
      pricingBreakpoints.set(breakpointKey, breakpoints);
    }
    const previousIndex = breakpoints.get(rule.maxQuantity);
    if (previousIndex !== undefined) {
      add(
        ['services', serviceSlug, 'pricing', index],
        `service ${serviceSlug} pricing rule ${index} (pickup=${rule.pickup ?? 'none'}, maxQuantity=${rule.maxQuantity}) duplicates and shadows rule ${previousIndex}; remove or change one breakpoint`,
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

  const highest = Math.max(...service.pricing.map((row) => row.maxQuantity), 0);
  const quantityValues = Array.from({ length: highest }, (_, index) => index + 1);
  // Plan 023 (design decision 2): coverage is checked per declared pickup id when location-ful, or
  // once (the '' key) when location-less — mirrors the breakpoint map above.
  const coverageKeys = location ? pickupOptionIds : [''];
  for (const quantity of quantityValues) {
    for (const key of coverageKeys) {
      if (!service.pricing.some((row) => (row.pickup ?? '') === key && quantity <= row.maxQuantity)) {
        add(
          ['services', serviceSlug, 'pricing'],
          location ? `missing ${key} pricing for quantity=${quantity}` : `missing pricing for quantity=${quantity}`,
        );
      }
    }
  }
  // Plan 024 (design decision 1): key uniqueness and select-needs-options are the whole shape
  // check config validation owns; per-value type/required/maxLength enforcement happens at
  // checkout (handlers/checkout.ts), where the request body is available.
  const seenMetadataKeys = new Set<string>();
  for (const [index, field] of (service.metadataFields ?? []).entries()) {
    if (seenMetadataKeys.has(field.key)) {
      add(['services', serviceSlug, 'metadataFields', index, 'key'], `duplicate metadata field key (${field.key}); keys must be unique within a service`);
    }
    seenMetadataKeys.add(field.key);
    if (field.type === 'select') {
      if (!field.options || field.options.length === 0) {
        add(['services', serviceSlug, 'metadataFields', index, 'options'], `metadata field ${field.key} declares type 'select' and must declare at least one option`);
      } else {
        const seenOptionValues = new Set<string>();
        for (const [optionIndex, option] of field.options.entries()) {
          if (seenOptionValues.has(option.value)) {
            add(['services', serviceSlug, 'metadataFields', index, 'options', optionIndex, 'value'], `duplicate option value (${option.value}) for metadata field ${field.key}; option values must be unique`);
          }
          seenOptionValues.add(option.value);
        }
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
// declared point. Throws for a service that declares no meeting points at all — checkout only ever
// calls this after confirming the chosen pickup option actually uses one (checkSlot/checkout.ts).
export function resolveMeetingPoint(service: ServiceConfig, meetingPointId?: string): MeetingPoint {
  const points = service.location?.meetingPoints ?? [];
  if (points.length === 0) {
    throw new Error('service declares no meeting points');
  }
  if (meetingPointId) {
    const match = points.find((point) => point.id === meetingPointId);
    if (match) return match;
  }
  return points[0]!;
}

// Plan 023 (design decision 1): no fixed default/custom pickup-options fallback anymore — a
// service with no `location` has no pickup options to match, and a null id (the location-less
// booking's stored value) is never a real option either way.
export function pickupOptionFor(service: ServiceConfig, id: string | null): PickupOption | undefined {
  if (id === null) return undefined;
  return service.location?.pickupOptions.find((option) => option.id === id);
}

// Plan 023 (design decision 4): the read-surface gate every email/manage/admin/calendar render
// site now shares. A booking has location data iff its pickupType is non-null — checkout writes
// NULL for a location-less service, and NULL is also what any pre-023 row already carries if
// nothing was ever collected. Once there IS a pickupType, presentation prefers the currently
// declared option; a stale/removed id (the service was reconfigured since the booking was made)
// falls back to what the row itself proves was collected, rather than guessing from the retired
// fixed 'default'/'custom' pickup-options pair.
export function pickupPresentationFor(
  service: ServiceConfig,
  booking: { pickupType: PickupType | null; pickupAddress: string | null; meetingPointId: string | null },
): { requiresAddress: boolean; usesMeetingPoint: boolean } | null {
  if (booking.pickupType === null) return null;
  const option = pickupOptionFor(service, booking.pickupType);
  return {
    requiresAddress: option ? option.requiresAddress : booking.pickupAddress !== null,
    usesMeetingPoint: option ? option.usesMeetingPoint : booking.meetingPointId !== null,
  };
}

// Plan 017 (design decision 3): per-booking rendering resolution, shared by the manage/
// confirmation payloads, brevo, calendar, and the admin table. Unlike resolveMeetingPoint's
// first-point fallback (checkout-time resolution against currently-declared points), a stored id
// that is NO LONGER declared falls back to the booking's stored label snapshot with no maps link —
// validateConfig cannot cross-check the DB, and an operator may remove a point (or the whole
// location module) that existing bookings still reference. Never throws: callers gate on
// pickupPresentationFor first, but a service that has since dropped location entirely (design
// decision 4 — pre-v2 rows must still render) must still degrade gracefully here too.
export function meetingPointForBooking(
  service: ServiceConfig,
  meetingPointId: string | null,
  meetingPointLabel: string | null,
): { label: string; mapsUrl: string | null } {
  const points = service.location?.meetingPoints ?? [];
  if (meetingPointId) {
    const match = points.find((point) => point.id === meetingPointId);
    if (match) return { label: match.label, mapsUrl: match.mapsUrl };
    return { label: meetingPointLabel ?? meetingPointId, mapsUrl: null };
  }
  const first = points[0];
  if (first) return { label: first.label, mapsUrl: first.mapsUrl };
  return { label: meetingPointLabel ?? '', mapsUrl: null };
}

// Plan 024 (design decision 1): the same candidate-locale-then-default-then-base-language fallback
// chain config.ui.messages/config.emails.messages already use (src/ui/messages.ts, src/providers/
// brevo.ts) — duplicated narrowly here rather than imported, since core must not depend on the ui
// layer and this file is metadata's only declaration point.
function metadataLabelCandidates(locale: string, defaultLocale: string): string[] {
  const values = [locale, locale.split('-')[0], defaultLocale, defaultLocale.split('-')[0]];
  return values.filter((value, index): value is string => Boolean(value) && values.indexOf(value) === index);
}

export function resolveMetadataFieldLabel(label: LocalizedText, locale: string, defaultLocale: string): string {
  if (typeof label === 'string') return label;
  for (const candidate of metadataLabelCandidates(locale, defaultLocale)) {
    const value = label[candidate];
    if (value) return value;
  }
  return Object.values(label)[0] ?? '';
}

export interface MetadataRow {
  key: string;
  label: string;
  // A raw boolean/number/string, or (for `select`) the resolved option label — never the bare
  // option value. Renderers turn boolean into the existing yes/no copy pair and everything else
  // into its plain string form; every renderer HTML-escapes it, since this is attacker-controlled
  // free text for `text` fields.
  value: string | number | boolean;
}

// Plan 024 (design decision 3): the one place a booking's raw stored metadata is turned into
// labeled, presentation-ready rows — shared by the manage/confirmation JSON payloads and the email
// renderer so a field's label and a select value's option label can never be resolved two
// different ways. A stored key no longer declared (the service dropped or renamed a field since
// the booking was made) is silently omitted rather than shown unlabeled, the same tolerance
// meetingPointForBooking/pickupOptionFor already apply to a stale config reference.
export function metadataRowsForBooking(
  service: ServiceConfig,
  metadata: Record<string, unknown> | null,
  locale: string,
  defaultLocale: string,
): MetadataRow[] {
  if (!metadata) return [];
  const rows: MetadataRow[] = [];
  for (const field of service.metadataFields ?? []) {
    if (!(field.key in metadata)) continue;
    const raw = metadata[field.key];
    const label = resolveMetadataFieldLabel(field.label, locale, defaultLocale);
    if (field.type === 'select') {
      const option = field.options?.find((candidate) => candidate.value === raw);
      if (option) rows.push({ key: field.key, label, value: resolveMetadataFieldLabel(option.label, locale, defaultLocale) });
      else if (typeof raw === 'string') rows.push({ key: field.key, label, value: raw });
      continue;
    }
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      rows.push({ key: field.key, label, value: raw });
    }
  }
  return rows;
}
