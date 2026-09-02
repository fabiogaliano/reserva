import { z } from 'astro/zod';
import { CURRENCY_CODE_PATTERN } from './currency.js';
import {
  BOOKING_EVENT_SUBSCRIBER_NAME_PATTERN,
  invalidSubscriberNameMessage,
  isBookingEvent,
  unknownBookingEventsMessage,
  type BookingEvent,
} from './events.js';

// A plain string: the pickup axis is whatever ids a service declares in
// `ServiceConfig.location.pickupOptions`, which no static union can enumerate.
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
  // Optional: a service with no `location` module has no pickup axis, so rules select by quantity
  // tier alone. A `location` service requires every rule to name a declared pickup option id.
  pickup?: PickupType;
  priceMinor: number;
}

export interface MeetingPoint {
  id: string;
  label: string;
  mapsUrl: string;
}

// The unit the pricing axis's `pickup` column points at. `requiresAddress` gates address
// collection at checkout; `usesMeetingPoint` decides the meeting-point requirement instead of a
// fixed `pickupType === 'default'`. Missing `label`/`hint` fall back to message-catalog copy.
export interface PickupOption {
  id: string;
  label?: string;
  hint?: string;
  requiresAddress: boolean;
  usesMeetingPoint: boolean;
}

// Either a plain string or a per-locale map, resolved with the same candidate-locale → base
// language → default-locale fallback as `config.ui.messages` (see `resolveMetadataFieldLabel`).
export type LocalizedText = string | Record<string, string>;

export interface MetadataFieldOption {
  value: string;
  label: LocalizedText;
}

// The whole consumer-declared metadata DSL: four types, three optional modifiers, no conditional
// fields, cross-field rules, or custom validators. `maxLength` applies to `text` only (default
// 500, enforced at checkout).
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
  // Opt-in per service; absent means no pickup/meeting-point dimension anywhere (pricing, checkout,
  // emails, admin, calendar). Requires at least one pickup option; meeting points stay optional.
  location?: {
    meetingPoints?: MeetingPoint[];
    pickupOptions: PickupOption[];
  };
  // Extension point for business-specific fields — dietary notes, skill level, etc. Absent means no
  // metadata; checkout rejects a non-empty `metadata` body for it.
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
    // Any ISO 4217 alphabetic code, lowercase. Prices are stored in this currency's minor unit;
    // the payment provider validates its own narrower set.
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
    // Present auto-selects Cloudflare Access as the admin/ops auth; absent requires a custom
    // `adminAuth` callback. Exactly one is required when admin/ops routes are enabled — checked at
    // runtime init, not here, since this schema can't see a runtime-only callback.
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
    // Token lifetime counted from booking end, not creation, so links survive reschedules, refund
    // follow-up, and review requests. Defaults to `DEFAULT_TOKEN_EXPIRY_DAYS` when unset.
    tokenExpiryDays?: number;
  };
  locales: {
    supported: string[];
    default: string;
  };
  legal: {
    termsUrl: string;
  };
  // `url` is ordinary config; the signing key is a Worker secret referenced by binding name, so it
  // never lives in a committed config file. A hook and a webhook may share a name — outbox rows
  // tell them apart by `family`, not a qualified key.
  webhooks?: WebhookEndpointConfig[];
  // One shared declaration drives both route injection and admin-auth selection, instead of two
  // options that could disagree. Both default to `true`; the booking API and manage routes are
  // load-bearing and never disableable here.
  routes?: {
    admin?: boolean;
    ops?: boolean;
    // Controls only the built-in server-rendered /booking/manage page; the manage/cancel/reschedule
    // APIs stay mounted either way. False stops library link producers from pointing at it.
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

// Long enough to cover post-service reschedules, refund disputes, and review-request follow-ups,
// without being effectively unlimited.
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

// Slug-safe so an id can be used verbatim as a `data-` attribute
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

// The wire/storage key — lowercase, `_`-separated, capped at 32
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

// `pickupOptions` is required (at least one) within a declared location; `meetingPoints` stays
// optional since a service can collect only a custom address.
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
    // A plain zod enum can't express a per-service id set; `validateService` checks each row's
    // pickup against the service's own declared location options.
    pickup: z.string().min(1).optional(),
    priceMinor: z.number().int().nonnegative(),
  })).min(1),
  occupancyFor: z.custom<(quantity: number) => number>((value) => typeof value === 'function').optional(),
  location: locationSchema.optional(),
  metadataFields: z.array(metadataFieldSchema).optional(),
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

function validateService(service: ServiceConfig, serviceSlug: string, add: (path: (string | number)[], message: string) => void): void {
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

  // Keyed by declared pickup id when location-ful, or a single '' key (tiers only) otherwise.
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
  // Coverage is checked per declared pickup id when location-ful, or once (the '' key) otherwise.
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
  // Config validation only checks key uniqueness and select-needs-options; per-value
  // type/required/maxLength enforcement happens at checkout, where the request body is available.
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
  // Only the floor is a core rule: a hold shorter than the payment session it guards can expire
  // while the session is still payable, which oversells. The payment provider enforces any ceiling.
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
  // Same closed-vocabulary check as hooks at startup: a typo'd event name fails the build with
  // the valid set in the message, rather than silently never firing.
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

// Id match wins; no id or unknown id falls back to the first declared point. Throws if the
// service declares no meeting points — callers must confirm the pickup option uses one first.
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

// No fixed default/custom fallback: a service with no `location` has no options to match, and a
// null id is never a real option either way.
export function pickupOptionFor(service: ServiceConfig, id: string | null): PickupOption | undefined {
  if (id === null) return undefined;
  return service.location?.pickupOptions.find((option) => option.id === id);
}

// A booking has location data iff `pickupType` is non-null. Once set, presentation prefers the
// currently declared option; a stale/removed id falls back to what the row itself recorded.
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

// Shared rendering resolution for manage/confirmation, calendar, and admin. A stored id no longer
// declared falls back to the booking's stored label with no maps link, since config can't be
// cross-checked against the DB. Never throws: must degrade for services that dropped location.
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

// Same locale-fallback chain as `config.ui.messages`, duplicated here rather than imported:
// core must not depend on the ui layer, and this file is metadata's only declaration point.
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
  // Raw boolean/number/string, or (for `select`) the resolved option label. Every renderer
  // HTML-escapes this — it's attacker-controlled free text for `text` fields.
  value: string | number | boolean;
}

// Turns a booking's raw metadata into labeled rows, shared by manage/confirmation JSON and email
// rendering so labels never resolve two different ways. A key no longer declared is silently
// omitted, the same stale-config tolerance as `meetingPointForBooking`.
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
