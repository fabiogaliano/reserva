import { z } from 'astro/zod';
import { CURRENCY_CODE_PATTERN } from './currency.js';
import {
  BOOKING_EVENT_SUBSCRIBER_NAME_PATTERN,
  invalidSubscriberNameMessage,
  isWebhookEvent,
  unknownBookingEventsMessage,
  type WebhookEvent,
} from './events.js';

// A plain string: the pickup axis is whatever ids a service declares in
// `ServiceConfig.location.pickupOptions`, which no static union can enumerate.
export type PickupType = string;

export function adminLocaleFor(config: ResolvedClientConfig): string {
  return config.admin.locale ?? config.locales.default;
}

// Long enough to cover post-service reschedules, refund disputes, and review-request follow-ups,
// without being effectively unlimited.
export const DEFAULT_TOKEN_EXPIRY_DAYS = 60;

export const DEFAULT_FIRST_START = '09:00';
export const DEFAULT_LAST_START = '18:00';

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const monthDayPattern = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const scheduleSchema = z.object({
  from: z.string().regex(monthDayPattern).optional(),
  to: z.string().regex(monthDayPattern).optional(),
  days: z.array(z.number().int().min(0).max(6)).min(1),
  // A conventional 09:00–18:00 day so a minimal config only has to say which days it operates;
  // both remain per-rule overridable here and per-deployment from the admin settings page.
  firstStart: z.string().regex(timePattern).default(DEFAULT_FIRST_START),
  // No schema-level default: `lastEnd` is the alternative spelling, and the service-level transform
  // is the only place that knows `durationMin` and can therefore derive one from the other.
  lastStart: z.string().regex(timePattern).optional(),
  // The closing time an operator actually thinks in ("last tour back by 19:00"); the last departure
  // is derived from it so a duration change does not have to be subtracted by hand in config.
  lastEnd: z.string().regex(timePattern).optional(),
  intervalMin: z.number().int().positive(),
});

function minutesOfDay(time: string): number {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return hour * 60 + minute;
}

function timeOfMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// Floored to the interval grid anchored at `firstStart`, so the derived value is a start time the
// slot generator would actually produce rather than an arbitrary instant. Clamped at `firstStart`;
// `validateService` is what rejects a `lastEnd` that cannot fit a single booking.
function derivedLastStart(rule: { firstStart: string; lastEnd?: string | undefined; intervalMin: number }, durationMin: number): string {
  const first = minutesOfDay(rule.firstStart);
  const latest = minutesOfDay(rule.lastEnd ?? rule.firstStart) - durationMin;
  if (latest <= first) return rule.firstStart;
  return timeOfMinutes(first + Math.floor((latest - first) / rule.intervalMin) * rule.intervalMin);
}

// `slots.ts` and `occupancy.ts` only ever ask for a last START, so every resolved rule carries one
// whichever spelling the config used. `lastEnd` survives on the resolved rule for display only.
function resolveScheduleRule(rule: z.output<typeof scheduleSchema>, durationMin: number): ResolvedScheduleRule {
  if (rule.lastStart !== undefined || rule.lastEnd === undefined) {
    return { ...rule, lastStart: rule.lastStart ?? DEFAULT_LAST_START };
  }
  return { ...rule, lastStart: derivedLastStart(rule, durationMin) };
}

// 8 KB per entry: `meta` rides on every catalog response, so an unbounded blob would be paid for on
// every page build and every widget load.
const META_MAX_BYTES = 8 * 1024;

// `JSON.stringify` silently drops a function or `undefined` instead of throwing, so a round-trip
// comparison would pass for a value that lost data. This walks the tree and rejects anything that
// is not already a JSON value.
function isJsonValue(value: unknown, depth: number): boolean {
  if (depth > 32) return false;
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object': {
      if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      return Object.values(value as Record<string, unknown>).every((entry) => isJsonValue(entry, depth + 1));
    }
    default:
      return false;
  }
}

function isSerializableMeta(value: Record<string, unknown>): boolean {
  if (!isJsonValue(value, 0)) return false;
  return new TextEncoder().encode(JSON.stringify(value)).length <= META_MAX_BYTES;
}

// Opaque passthrough: reserva never reads a key of it, it only guarantees the value survives the
// catalog's JSON round-trip, so a site can keep its per-service content next to the service itself.
const metaSchema = z.record(z.string(), z.unknown())
  .refine(isSerializableMeta, 'must be JSON-serializable and under 8 KB')
  .optional();

// Either a plain string or a per-locale map, resolved with the same candidate-locale → base
// language → default-locale fallback as `config.ui.messages` (see `resolveLocalizedText`).
const localizedTextSchema = z.union([z.string().min(1), z.record(z.string(), z.string().min(1))]);

// Slug-safe so an id can be used verbatim as a `data-` attribute
// value, a widget radio input's `value`, and a URL-safe checkout body field without escaping.
const pickupOptionIdPattern = /^[a-z0-9_-]+$/;

// The unit the pricing axis's `pickup` column points at. `requiresAddress` gates address
// collection at checkout; `usesMeetingPoint` decides the meeting-point requirement. Ids are opaque
// to the library, so `label` is required: nothing else can name the option to a customer.
const pickupOptionShape = z.object({
  id: z.string().min(1).regex(pickupOptionIdPattern),
  // Optional at runtime, required by `locationSchema`'s refinement for every option a consumer
  // declares: the implied `meeting_point` option carries no label, and a resolved config must
  // re-validate unchanged. The input type below still requires it, so a missing label is a
  // compile error for the consumer and a named validation error at runtime.
  label: localizedTextSchema.optional(),
  hint: localizedTextSchema.optional(),
  requiresAddress: z.boolean(),
  usesMeetingPoint: z.boolean(),
});
type PickupOptionInput = Omit<z.input<typeof pickupOptionShape>, 'label'> & { label: z.input<typeof localizedTextSchema> };
const pickupOptionSchema = pickupOptionShape as unknown as z.ZodType<z.output<typeof pickupOptionShape>, PickupOptionInput>;

const meetingPointSchema = z.object({
  id: z.string().min(1),
  label: localizedTextSchema,
  mapsUrl: z.string().url(),
  meta: metaSchema,
});

// The wire/storage key — lowercase, `_`-separated, capped at 32
// characters so it's safe to use verbatim as a JSON object key and a checkout body field.
export const METADATA_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

const metadataFieldOptionSchema = z.object({
  value: z.string().min(1),
  label: localizedTextSchema,
});

// The whole consumer-declared metadata DSL: four types, three optional modifiers, no conditional
// fields, cross-field rules, or custom validators. `maxLength` applies to `text` only (default
// 500, enforced at checkout).
const metadataFieldSchema = z.object({
  key: z.string().regex(METADATA_FIELD_KEY_PATTERN),
  label: localizedTextSchema,
  type: z.enum(['text', 'number', 'boolean', 'select']),
  options: z.array(metadataFieldOptionSchema).min(1).optional(),
  required: z.boolean().optional(),
  maxLength: z.number().int().positive().optional(),
});

// A location module may declare only `meetingPoints`: the transform implies a single
// meeting-point pickup option so the resolved shape always carries a pickup axis. `meetingPoints`
// stays optional for a service that only collects a custom address.
const locationSchema = z.object({
  meetingPoints: z.array(meetingPointSchema).min(1).optional(),
  pickupOptions: z.array(pickupOptionSchema).min(1).optional(),
}).superRefine((location, ctx) => {
  location.pickupOptions?.forEach((option, index) => {
    // Ids are opaque, so nothing but a declared label can name an option to a customer. The implied
    // meeting-point option is the one exception: renderers name it from the `pickup.meetingPoint`
    // message key, so a resolved config round-trips through this check unchanged.
    if (option.label === undefined && option.id !== IMPLIED_MEETING_POINT_PICKUP_ID) {
      ctx.addIssue({ code: 'custom', path: ['pickupOptions', index, 'label'], message: 'required' });
    }
  });
  if (!location.meetingPoints && !location.pickupOptions) {
    ctx.addIssue({
      code: 'custom',
      path: [],
      message: "a declared location module must set 'pickupOptions', 'meetingPoints', or both; remove the location key for a service with no pickup dimension",
    });
  }
}).transform((location) => {
  const pickupOptions: PickupOption[] = location.pickupOptions
    ?? [{ id: IMPLIED_MEETING_POINT_PICKUP_ID, requiresAddress: false, usesMeetingPoint: true }];
  return { ...location, pickupOptions };
});

const pricingRuleSchema = z.object({
  maxQuantity: z.number().int().positive(),
  // A plain zod enum can't express a per-service id set; `validateService` checks each row's
  // pickup against the service's own declared location options.
  pickup: z.string().min(1).optional(),
  priceMinor: z.number().int().nonnegative(),
});

// Whether a pickup surcharge is charged once per booking or once per capacity unit: a hotel
// pick-up that needs a second vehicle costs the operator twice, a single-address meeting fee
// does not.
const surchargeScopeSchema = z.enum(['unit', 'booking']);
const surchargesSchema = z.record(z.string().min(1), z.number().int().nonnegative());

// The business-wide half of formula pricing. Every formula service inherits whichever of these it
// does not declare itself, so a fleet-wide pick-up surcharge is one number, not one per service.
const sharedPricingSchema = z.object({
  surcharges: surchargesSchema.default({}),
  maxUnits: z.number().int().positive().default(1),
  surchargeScope: surchargeScopeSchema.default('unit'),
}).prefault({});

// Formula pricing: `baseMinor` per capacity unit, times the units the party needs
// (`ceil(quantity / occupancy.seatsPerUnit)`), plus the pickup option's surcharge. Fields left
// undeclared inherit the top-level `pricing` block. `seatsPerUnit` and `inherited` are resolved-only:
// the first lets `priceFor` work on a service (or catalog entry) alone, the second records which
// fields came from the shared block so a re-validation of a resolved config keeps following it.
// `resolveServicePricing` only honours the flag when the value still matches the shared block.
const formulaPricingSchema = z.object({
  baseMinor: z.number().int().nonnegative(),
  surcharges: surchargesSchema.optional(),
  maxUnits: z.number().int().positive().optional(),
  surchargeScope: surchargeScopeSchema.optional(),
  seatsPerUnit: z.number().int().positive().optional(),
  inherited: z.object({ surcharges: z.boolean(), maxUnits: z.boolean(), surchargeScope: z.boolean() }).optional(),
});

const serviceSchema = z.object({
  // Customer-facing display name wherever a human reads the service ("Your Alfama Discovery is
  // confirmed"). Required: a slug is an identifier, never a name to put in front of a customer.
  title: localizedTextSchema,
  durationMin: z.number().int().positive(),
  turnaroundMin: z.number().int().nonnegative(),
  // Absent inherits the top-level `hours` block. `scheduleSource` is resolved-only: a materialized
  // inherited schedule must re-derive from `hours` on re-validation instead of freezing.
  schedule: z.array(scheduleSchema).min(1).optional(),
  scheduleSource: z.enum(['service', 'hours']).optional(),
  // Either breakpoint rows (any price curve, typed by hand) or a formula (base × units + surcharge).
  pricing: z.union([z.array(pricingRuleSchema).min(1), formulaPricingSchema]),
  // How many seats one capacity unit holds (a 4-seat vehicle, a 6-person table). Absent means one
  // unit per booking regardless of party size.
  occupancy: z.object({ seatsPerUnit: z.number().int().positive() }).optional(),
  // Declared only to reject it by name: silently stripping an unknown key would leave a deployment
  // that still reads as a working config while quietly overselling.
  occupancyFor: z.unknown().optional().refine((value) => value === undefined, 'replaced by occupancy.seatsPerUnit'),
  // Opt-in per service; absent means no pickup/meeting-point dimension anywhere (pricing, checkout,
  // emails, admin, calendar).
  location: locationSchema.optional(),
  // Extension point for business-specific fields — dietary notes, skill level, etc. Absent means no
  // metadata; checkout rejects a non-empty `metadata` body for it.
  metadataFields: z.array(metadataFieldSchema).optional(),
  // Opaque site content (images, taglines, coordinates) the catalog echoes back, so a static site
  // builds its pages from the same call that gives it prices.
  meta: metaSchema,
}).transform(({ occupancyFor: _rejected, ...service }) => {
  // Normalized in the schema rather than in `validateConfig` so `z.output` is the single source of
  // truth for the resolved shape: every runtime reader sees `pickupOptions` present and a
  // single-option service's pricing rows already carry `pickup`, with no extra narrowing. The
  // schedule and formula pricing are finished by the top-level transform, which is the first place
  // that can see the shared `hours` and `pricing` blocks they may inherit from.
  const options = service.location?.pickupOptions ?? [];
  const only = options.length === 1 ? options[0]! : undefined;
  const pricing = Array.isArray(service.pricing) && only
    ? service.pricing.map((rule) => rule.pickup === undefined ? { ...rule, pickup: only.id } : rule)
    : service.pricing;
  return { ...service, pricing };
});

type ParsedServiceConfig = z.output<typeof serviceSchema>;

export interface ResolvedFormulaPricing {
  baseMinor: number;
  // Only the service's own declared pickup option ids: the shared table may carry ids that belong
  // to other services, and they must not become price-table columns here.
  surcharges: Record<string, number>;
  maxUnits: number;
  surchargeScope: 'unit' | 'booking';
  seatsPerUnit: number;
  inherited: { surcharges: boolean; maxUnits: boolean; surchargeScope: boolean };
}

export type ResolvedServiceConfig = Omit<ParsedServiceConfig, 'schedule' | 'scheduleSource' | 'pricing'> & {
  schedule: ResolvedScheduleRule[];
  // Absent reads as 'service': a hand-built resolved service (tests, adapters) owns its schedule.
  scheduleSource?: 'service' | 'hours';
  pricing: PricingRule[] | ResolvedFormulaPricing;
};

// Only the ids a service declares: the shared table may carry ids that belong to other services.
export function surchargesFor(table: Record<string, number>, pickupIds: string[]): Record<string, number> {
  const surcharges: Record<string, number> = {};
  for (const id of pickupIds) {
    const amount = table[id];
    if (amount !== undefined) surcharges[id] = amount;
  }
  return surcharges;
}

function sameSurcharges(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function resolveServicePricing(
  service: ParsedServiceConfig,
  shared: z.output<typeof sharedPricingSchema>,
): PricingRule[] | ResolvedFormulaPricing {
  if (Array.isArray(service.pricing)) return service.pricing;
  const formula = service.pricing;
  const pickupIds = (service.location?.pickupOptions ?? []).map((option) => option.id);
  const sharedView = surchargesFor(shared.surcharges, pickupIds);
  // A field inherits iff it was left undeclared, or a re-parse of a resolved config says it was
  // inherited *and* the materialized value still matches the shared block. The second check is
  // what keeps `inherited` from being a consumer-facing override switch: a config that declares
  // amounts and also claims they were inherited gets the amounts it wrote, never the shared table.
  const claims = formula.inherited;
  const inherited = {
    surcharges: formula.surcharges === undefined
      || (claims?.surcharges === true && sameSurcharges(surchargesFor(formula.surcharges, pickupIds), sharedView)),
    maxUnits: formula.maxUnits === undefined || (claims?.maxUnits === true && formula.maxUnits === shared.maxUnits),
    surchargeScope: formula.surchargeScope === undefined
      || (claims?.surchargeScope === true && formula.surchargeScope === shared.surchargeScope),
  };
  // A location-less service has no pickup axis, so it keeps no surcharge column even if the shared
  // table is non-empty. `validateService` reports a declared option the table does not price.
  const surcharges = inherited.surcharges ? sharedView : surchargesFor(formula.surcharges ?? {}, pickupIds);
  return {
    baseMinor: formula.baseMinor,
    surcharges,
    maxUnits: inherited.maxUnits ? shared.maxUnits : formula.maxUnits!,
    surchargeScope: inherited.surchargeScope ? shared.surchargeScope : formula.surchargeScope!,
    // `validateService` rejects a formula service with no `occupancy`; the fallback only keeps the
    // resolved shape total so that error can be reported alongside the others.
    seatsPerUnit: service.occupancy?.seatsPerUnit ?? 1,
    inherited,
  };
}

function resolveServiceConfig(
  service: ParsedServiceConfig,
  hours: ScheduleRule[] | undefined,
  shared: z.output<typeof sharedPricingSchema>,
): ResolvedServiceConfig {
  const { schedule: declared, scheduleSource, ...rest } = service;
  const own = scheduleSource !== 'hours' && declared !== undefined;
  // A service with neither its own schedule nor a shared block to inherit resolves to no rules;
  // `validateService` is what names that as an error.
  const source = own ? declared : hours ?? [];
  return {
    ...rest,
    schedule: source.map((rule) => resolveScheduleRule(rule, service.durationMin)),
    scheduleSource: own ? 'service' : 'hours',
    pricing: resolveServicePricing(service, shared),
  };
}

const bookingSchema = z.object({
  minNoticeHours: z.number().nonnegative().default(0),
  maxHorizonDays: z.number().int().positive().default(90),
  holdMinutes: z.number().int().nonnegative().default(35),
  cancelCutoffHours: z.number().nonnegative().default(24),
  reschedule: z.object({
    enabled: z.boolean().default(true),
    // Absent inherits `cancelCutoffHours`: one dial covers both customer-initiated changes unless
    // a client deliberately splits them.
    cutoffHours: z.number().nonnegative().optional(),
  }).prefault({}),
  limitedThreshold: z.number().int().nonnegative().default(2),
  // How long before the start the reminder email goes out. `0` disables reminders entirely; a
  // booking made inside the window never gets one (it just received its confirmation).
  reminderHoursBefore: z.number().int().nonnegative().default(24),
  calendarMaxStaleSeconds: z.number().int().min(60).default(15 * 60),
  maxHoldsPerIp: z.number().int().positive().optional(),
  // Token lifetime counted from booking end, not creation, so links survive reschedules, refund
  // follow-up, and review requests. Defaults to `DEFAULT_TOKEN_EXPIRY_DAYS` when unset.
  tokenExpiryDays: z.number().int().positive().optional(),
}).prefault({}).transform((booking) => ({
  ...booking,
  reschedule: { ...booking.reschedule, cutoffHours: booking.reschedule.cutoffHours ?? booking.cancelCutoffHours },
}));

const webhookEndpointSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  // Must also be listed in the runtime's `secretBindings` for reserva to be allowed to read it.
  secretBinding: z.string().min(1),
  // Defaults to every event in BOOKING_EVENTS — `settings.changed` is never implied, so a
  // booking-only subscriber declared before it existed never starts receiving it. Any string
  // parses so `validateConfig` can report a typo'd name with the valid set, instead of a bare
  // enum mismatch.
  events: z.array(z.custom<WebhookEvent>((value) => typeof value === 'string')).min(1).optional(),
});

const clientConfigShape = z.object({
  business: z.object({
    name: z.string().min(1),
    shortCode: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,9}$/),
    url: z.string().url(),
    timezone: z.string().min(1),
    // Any ISO 4217 alphabetic code, lowercase. Prices are stored in this currency's minor unit;
    // the payment provider validates its own narrower set.
    currency: z.string().regex(CURRENCY_CODE_PATTERN, 'must be a lowercase ISO 4217 alphabetic code (e.g. "eur", "jpy")'),
    contact: z.object({
      email: z.string().email(),
      phone: z.string().min(1),
      // A second phone line, shown alongside `phone` wherever contact details render.
      phoneSecondary: z.string().min(1).optional(),
      whatsapp: z.string().optional(),
    }),
  }),
  capacity: z.object({ default: z.number().int().nonnegative() }),
  admin: z.object({
    // Present auto-selects Cloudflare Access as the admin/ops auth; absent requires a custom
    // `adminAuth` callback. Exactly one is required when admin/ops routes are enabled — checked at
    // runtime init, not here, since this schema can't see a runtime-only callback.
    access: z.object({
      teamDomain: z.string().refine(isValidAccessTeamDomain, 'must be an HTTPS Cloudflare Access origin'),
      aud: z.string().min(1),
    }).optional(),
    // Operator copy can differ from the locale used for customer pages, emails, and checkout.
    locale: z.string().min(1).refine(isValidLocale, 'must be a valid BCP 47 locale').optional(),
  }).prefault({}),
  // The business's opening hours, inherited by every service that declares no `schedule` of its
  // own. Each service still derives its own last departure from a rule's `lastEnd`.
  hours: z.array(scheduleSchema).min(1).optional(),
  // The business-wide half of formula pricing; see `formulaPricingSchema`.
  pricing: sharedPricingSchema,
  services: z.record(z.string(), serviceSchema).refine((value) => Object.keys(value).length > 0, 'at least one service is required'),
  booking: bookingSchema,
  locales: z.object({
    supported: z.array(z.string().min(1)).min(1).default(['en']),
    default: z.string().min(1).default('en'),
  }).prefault({}),
  legal: z.object({ termsUrl: z.string().url().optional() }).prefault({}),
  // `url` is ordinary config; the signing key is a Worker secret referenced by binding name, so it
  // never lives in a committed config file. A hook and a webhook may share a name — outbox rows
  // tell them apart by `family`, not a qualified key.
  webhooks: z.array(webhookEndpointSchema).optional(),
  // One shared declaration drives both route injection and admin-auth selection, instead of two
  // options that could disagree. Both default to `true`; the booking API and manage routes are
  // load-bearing and never disableable here.
  routes: z.object({
    admin: z.boolean().optional(),
    ops: z.boolean().optional(),
    // Controls only the built-in server-rendered /booking/manage page; the manage/cancel/reschedule
    // APIs stay mounted either way. False stops library link producers from pointing at it.
    manage: z.boolean().optional(),
  }).optional(),
  ui: z.object({
    // Per-locale overrides for Reserva's rendered copy, merged over its bundled catalog and
    // English fallback. Keys are locale tags ('pt-PT', 'fr', …); values are partial message maps.
    messages: z.record(z.string(), z.record(z.string(), z.string())).optional(),
    // A URL or site-absolute path rendered as <link rel="icon"> on every page Reserva renders, so
    // the confirmation and manage pages carry the site's identity instead of the browser default.
    faviconUrl: z.string().min(1).optional(),
    // Raw head markup (a font link, a stylesheet overriding the --bk-* tokens), appended after
    // Reserva's own stylesheet so consumer CSS wins. Trusted verbatim and never escaped: it is the
    // consumer's own markup, and their CSP is the thing that bounds it.
    headHtml: z.string().optional(),
  }).optional(),
  emails: z.object({
    // Forces every outgoing email into one locale regardless of the language the customer booked
    // in. Absent keeps the per-booking locale (with the usual supported/default fallback).
    locale: z.string().min(1).refine(isValidLocale, 'must be a valid BCP 47 locale').optional(),
    // Visual identity for the branded email shell. All optional — a client without branding gets
    // a neutral dark header with the business name as text.
    branding: z.object({
      logoUrl: z.string().url().optional(),
      // Rendered size of the logo <img>; explicit dimensions because some desktop clients
      // (Outlook) otherwise paint the image at its natural pixel size.
      logoWidth: z.number().int().positive().optional(),
      logoHeight: z.number().int().positive().optional(),
      headerBackground: z.string().min(1).optional(),
      accentColor: z.string().min(1).optional(),
      cardBackground: z.string().min(1).optional(),
    }).optional(),
    // Per-locale overrides for email copy, merged over the bundled catalog exactly like
    // ui.messages is for widget copy.
    messages: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  }).optional(),
});

type ParsedClientConfig = z.output<typeof clientConfigShape>;

// Finishes what `serviceSchema` cannot: the shared `hours` and `pricing` blocks live one level up,
// so inheritance is resolved here, once, and the resolved shape is again the schema's own output.
export const clientConfigSchema = clientConfigShape.transform((config): ResolvedClientConfig => ({
  ...config,
  services: Object.fromEntries(Object.entries(config.services).map(([slug, service]) => [
    slug,
    resolveServiceConfig(service, config.hours, config.pricing),
  ])),
}));

// `ClientConfig` is what a consumer writes (every defaulted field optional); `ResolvedClientConfig`
// is what the runtime reads once defaults and normalization have been applied.
export type ClientConfig = z.input<typeof clientConfigShape>;
export type ResolvedClientConfig = Omit<ParsedClientConfig, 'services'> & { services: Record<string, ResolvedServiceConfig> };
export type ServiceConfig = z.input<typeof serviceSchema>;
// The writable half only: `seatsPerUnit` and `inherited` are resolved-only and not for a consumer to type.
export type FormulaPricing = Pick<z.input<typeof formulaPricingSchema>, 'baseMinor' | 'surcharges' | 'maxUnits' | 'surchargeScope'>;
export type SharedPricing = z.output<typeof sharedPricingSchema>;
export type SurchargeScope = z.output<typeof surchargeScopeSchema>;
export type ScheduleRule = z.output<typeof scheduleSchema>;
// What every runtime reader sees: `lastStart` is computed once (from `lastEnd` when that is the
// spelling the config used) so nothing downstream has to know which of the two was declared.
export type ResolvedScheduleRule = ScheduleRule & { lastStart: string };
export type PricingRule = z.output<typeof pricingRuleSchema>;
export type MeetingPoint = z.output<typeof meetingPointSchema>;
// The single pickup option implied for a service that declares meeting points and no pickup
// options. It is the one option with no declared label: renderers name it from the
// `pickup.meetingPoint` message key, resolved per request locale.
export const IMPLIED_MEETING_POINT_PICKUP_ID = 'meeting_point';
// `label` is required of everything a consumer declares (`locationSchema`'s refinement enforces it)
// but optional on the resolved shape, because the implied option above carries none.
export type PickupOption = z.output<typeof pickupOptionSchema>;
export type MetadataField = z.output<typeof metadataFieldSchema>;
export type MetadataFieldOption = z.output<typeof metadataFieldOptionSchema>;
export type LocalizedText = z.output<typeof localizedTextSchema>;
export type WebhookEndpointConfig = z.output<typeof webhookEndpointSchema>;

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

function monthDayValue(value: string): number {
  const [month = 0, day = 0] = value.split('-').map(Number);
  return month * 100 + day;
}

// A season is one or two month-day intervals: a rule whose `from` is after its `to` wraps the new year.
function seasonIntervals(rule: ScheduleRule): Array<[number, number]> {
  const from = rule.from ? monthDayValue(rule.from) : 101;
  const to = rule.to ? monthDayValue(rule.to) : 1231;
  return from <= to ? [[from, to]] : [[from, 1231], [101, to]];
}

function seasonsOverlap(left: ScheduleRule, right: ScheduleRule): boolean {
  return seasonIntervals(left).some(([leftFrom, leftTo]) =>
    seasonIntervals(right).some(([rightFrom, rightTo]) => leftFrom <= rightTo && rightFrom <= leftTo));
}

function scheduleStartTimes(rule: ResolvedScheduleRule): string[] {
  const [firstHour = 0, firstMinute = 0] = rule.firstStart.split(':').map(Number);
  const [lastHour = 0, lastMinute = 0] = rule.lastStart.split(':').map(Number);
  const starts: string[] = [];
  for (let minutes = firstHour * 60 + firstMinute; minutes <= lastHour * 60 + lastMinute; minutes += rule.intervalMin) {
    starts.push(`${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`);
  }
  return starts;
}

function validateService(service: ResolvedServiceConfig, serviceSlug: string, add: (path: (string | number)[], message: string) => void): void {
  const location = service.location;
  const pickupOptions = location?.pickupOptions ?? [];
  const pickupOptionIds = pickupOptions.map((option) => option.id);
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

  if (Array.isArray(service.pricing)) {
    validatePricingRules(service.pricing, location !== undefined, pickupOptionIds, serviceSlug, add);
  } else {
    // Checkout and availability count units with `occupancyFor`, which is one unit per booking when
    // `occupancy` is absent; a formula price that multiplied by headcount would then charge for
    // vehicles the booking never reserves.
    if (service.occupancy === undefined) {
      add(['services', serviceSlug, 'occupancy'], `service ${serviceSlug} uses formula pricing, so services.${serviceSlug}.occupancy.seatsPerUnit must be declared (it is what turns a party size into priced units)`);
    }
    validateFormulaPricing(service.pricing, pickupOptionIds, serviceSlug, add);
  }

  validateSchedule(service, serviceSlug, add);
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
}

// Every declared pickup option needs a surcharge, even a zero one: a silent default would price a
// hotel pick-up as free. The issue lands on the shared block when that is where the table came
// from, so an admin edit there is blamed on the right stored row.
function validateFormulaPricing(
  pricing: ResolvedFormulaPricing,
  pickupOptionIds: string[],
  serviceSlug: string,
  add: (path: (string | number)[], message: string) => void,
): void {
  const tablePath = pricing.inherited.surcharges ? ['pricing', 'surcharges'] : ['services', serviceSlug, 'pricing', 'surcharges'];
  for (const id of pickupOptionIds) {
    if (pricing.surcharges[id] === undefined) {
      add([...tablePath, id], `service ${serviceSlug} declares pickup option ${id}, so ${tablePath.join('.')} must price it (0 for no surcharge)`);
    }
  }
}

function validatePricingRules(
  rules: PricingRule[],
  hasLocation: boolean,
  pickupOptionIds: string[],
  serviceSlug: string,
  add: (path: (string | number)[], message: string) => void,
): void {
  const pickupOptionIdSet = new Set(pickupOptionIds);
  // Keyed by declared pickup id when location-ful, or a single '' key (tiers only) otherwise.
  const pricingBreakpoints = new Map<string, Map<number, number>>();
  for (const [index, rule] of rules.entries()) {
    if (hasLocation) {
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

  const highest = Math.max(...rules.map((row) => row.maxQuantity), 0);
  // Coverage is checked per declared pickup id when location-ful, or once (the '' key) otherwise.
  const coverageKeys = hasLocation ? pickupOptionIds : [''];
  for (let quantity = 1; quantity <= highest; quantity += 1) {
    for (const key of coverageKeys) {
      if (!rules.some((row) => (row.pickup ?? '') === key && quantity <= row.maxQuantity)) {
        add(
          ['services', serviceSlug, 'pricing'],
          hasLocation ? `missing ${key} pricing for quantity=${quantity}` : `missing pricing for quantity=${quantity}`,
        );
      }
    }
  }
}

// An inherited rule is reported under `hours.<i>` and a declared one under the service's own
// `schedule.<i>`: the settings load path attributes a failing merge to stored rows by path prefix,
// so the path has to name the block the operator actually edited.
function validateSchedule(service: ResolvedServiceConfig, serviceSlug: string, add: (path: (string | number)[], message: string) => void): void {
  if (service.schedule.length === 0) {
    add(['services', serviceSlug, 'schedule'], `service ${serviceSlug} declares no schedule and there is no top-level hours block to inherit; declare one or the other`);
    return;
  }
  const pathOf = (index: number): (string | number)[] =>
    service.scheduleSource === 'hours' ? ['hours', index] : ['services', serviceSlug, 'schedule', index];
  for (const [index, rule] of service.schedule.entries()) {
    const path = pathOf(index);
    const name = path.join('.');
    if (rule.from && !isValidMonthDay(rule.from)) {
      add([...path, 'from'], 'must be a valid month-day');
    }
    if (rule.to && !isValidMonthDay(rule.to)) {
      add([...path, 'to'], 'must be a valid month-day');
    }
    if (rule.firstStart > rule.lastStart) {
      add(path, 'firstStart must not be after lastStart');
    }
    if (rule.intervalMin > 24 * 60) {
      add([...path, 'intervalMin'], 'intervalMin must be at most one day');
    }
    if (rule.lastEnd !== undefined) {
      if (minutesOfDay(rule.lastEnd) - service.durationMin < minutesOfDay(rule.firstStart)) {
        add(path, `${name}: lastEnd ${rule.lastEnd} leaves no room for a ${service.durationMin}-minute booking of service ${serviceSlug} starting at firstStart ${rule.firstStart}`);
      } else if (rule.lastStart !== derivedLastStart(rule, service.durationMin)) {
        // Compared against the derived value rather than testing "both present": a resolved config
        // carries both, and it round-trips back through validateConfig (settings merges, the
        // virtual config module) where a bare presence check would reject its own output.
        add(path, `${name}: declare lastStart or lastEnd, not both`);
      }
    }
  }

  // Rules combine, so two rules that can fire on the same date must not produce the same start time:
  // one would silently shadow the other. Overlapping windows with distinct starts are legal.
  for (const [index, rule] of service.schedule.entries()) {
    for (const [otherIndex, other] of service.schedule.entries()) {
      if (otherIndex <= index) continue;
      if (!rule.days.some((day) => other.days.includes(day))) continue;
      if (!seasonsOverlap(rule, other)) continue;
      const shared = scheduleStartTimes(rule).filter((start) => scheduleStartTimes(other).includes(start));
      if (shared.length === 0) continue;
      add(
        pathOf(index),
        `${pathOf(index).join('.')} and ${pathOf(otherIndex).join('.')} share a weekday and season and both start at ${shared.join(', ')} for service ${serviceSlug}; schedule rules combine, so change one rule's firstStart or intervalMin`,
      );
    }
  }
}

export function validateConfig(input: unknown): ResolvedClientConfig {
  const parsed = clientConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw parsed.error;
  }
  const config = parsed.data;
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
  // Shared hours are validated through every service that inherits them (the duration-dependent
  // checks differ per service), so each rule's issues repeat once per inheriting service and are
  // deduplicated below. A block nobody inherits still gets its shape checked once.
  const inheritsHours = Object.values(config.services).some((service) => service.scheduleSource === 'hours');
  for (const [index, rule] of (config.hours ?? []).entries()) {
    if (inheritsHours) break;
    if (rule.from && !isValidMonthDay(rule.from)) add(['hours', index, 'from'], 'must be a valid month-day');
    if (rule.to && !isValidMonthDay(rule.to)) add(['hours', index, 'to'], 'must be a valid month-day');
    if (rule.lastStart !== undefined && rule.lastEnd !== undefined) add(['hours', index], `hours.${index}: declare lastStart or lastEnd, not both`);
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
      if (!isWebhookEvent(event)) add(['webhooks', index, 'events', eventIndex], unknownBookingEventsMessage(event));
    }
  }

  if (issues.length > 0) {
    const seen = new Set<string>();
    const result = clientConfigShape.superRefine((_, ctx) => {
      for (const issue of issues) {
        const key = `${issue.path.join('.')}\u0000${issue.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        addIssue(ctx, issue.path, issue.message);
      }
    }).safeParse(input);
    if (!result.success) throw result.error;
  }
  for (const service of Object.values(config.services)) {
    if (Array.isArray(service.pricing)) service.pricing.sort((a, b) => a.maxQuantity - b.maxQuantity);
  }
  return config;
}

// The largest party a service prices: the widest breakpoint row, or every seat of every unit a
// formula allows. Accepts a catalog entry as well as a resolved service.
export function maxQuantityFor(service: { pricing: ReadonlyArray<{ maxQuantity: number }> | { maxUnits: number; seatsPerUnit: number } }): number {
  if (Array.isArray(service.pricing)) return Math.max(...service.pricing.map((row) => row.maxQuantity), 0);
  const formula = service.pricing as { maxUnits: number; seatsPerUnit: number };
  return formula.maxUnits * formula.seatsPerUnit;
}

export function quantityValuesForService(service: ResolvedServiceConfig): number[] {
  return Array.from({ length: maxQuantityFor(service) }, (_, index) => index + 1);
}

export function resolveService(config: ResolvedClientConfig, serviceSlug: string): ResolvedServiceConfig {
  const service = config.services[serviceSlug];
  if (!service) throw new Error(`Unknown service: ${serviceSlug}`);
  return service;
}

// Id match wins; no id or unknown id falls back to the first declared point. Throws if the
// service declares no meeting points — callers must confirm the pickup option uses one first.
export function resolveMeetingPoint(service: ResolvedServiceConfig, meetingPointId?: string): MeetingPoint {
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
export function pickupOptionFor(service: ResolvedServiceConfig, id: string | null): PickupOption | undefined {
  if (id === null) return undefined;
  return service.location?.pickupOptions.find((option) => option.id === id);
}

// A booking has location data iff `pickupType` is non-null. Once set, presentation prefers the
// currently declared option; a stale/removed id falls back to what the row itself recorded.
export function pickupPresentationFor(
  service: ResolvedServiceConfig,
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
  service: ResolvedServiceConfig,
  meetingPointId: string | null,
  meetingPointLabel: string | null,
  locale: string,
  defaultLocale: string,
): { label: string; mapsUrl: string | null } {
  const points = service.location?.meetingPoints ?? [];
  const resolve = (label: LocalizedText): string => resolveLocalizedText(label, locale, defaultLocale);
  if (meetingPointId) {
    const match = points.find((point) => point.id === meetingPointId);
    if (match) return { label: resolve(match.label), mapsUrl: match.mapsUrl };
    return { label: meetingPointLabel ?? meetingPointId, mapsUrl: null };
  }
  const first = points[0];
  if (first) return { label: resolve(first.label), mapsUrl: first.mapsUrl };
  return { label: meetingPointLabel ?? '', mapsUrl: null };
}

// Same locale-fallback chain as `config.ui.messages`, duplicated here rather than imported:
// core must not depend on the ui layer, and this file declares every localized config value.
function localizedTextCandidates(locale: string, defaultLocale: string): string[] {
  const values = [locale, locale.split('-')[0], defaultLocale, defaultLocale.split('-')[0]];
  return values.filter((value, index): value is string => Boolean(value) && values.indexOf(value) === index);
}

// The one resolution for every `LocalizedText` in config — titles, meeting-point and pickup
// labels, metadata labels — so no two surfaces can disagree about which locale wins.
export function resolveLocalizedText(text: LocalizedText, locale: string, defaultLocale: string): string {
  if (typeof text === 'string') return text;
  for (const candidate of localizedTextCandidates(locale, defaultLocale)) {
    const value = text[candidate];
    if (value) return value;
  }
  return Object.values(text)[0] ?? '';
}

// Kept for one release so a consumer that imported the metadata-only name still compiles.
export const resolveMetadataFieldLabel = resolveLocalizedText;

// A booking can outlive the service that made it; a slug no longer declared is the only name left
// to show, so this degrades to it instead of throwing on a renderer's hot path.
export function resolveServiceTitle(config: ResolvedClientConfig, slug: string, locale: string): string {
  const service = config.services[slug];
  if (!service) return slug;
  return resolveLocalizedText(service.title, locale, config.locales.default);
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
  service: ResolvedServiceConfig,
  metadata: Record<string, unknown> | null,
  locale: string,
  defaultLocale: string,
): MetadataRow[] {
  if (!metadata) return [];
  const rows: MetadataRow[] = [];
  for (const field of service.metadataFields ?? []) {
    if (!(field.key in metadata)) continue;
    const raw = metadata[field.key];
    const label = resolveLocalizedText(field.label, locale, defaultLocale);
    if (field.type === 'select') {
      const option = field.options?.find((candidate) => candidate.value === raw);
      if (option) rows.push({ key: field.key, label, value: resolveLocalizedText(option.label, locale, defaultLocale) });
      else if (typeof raw === 'string') rows.push({ key: field.key, label, value: raw });
      continue;
    }
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      rows.push({ key: field.key, label, value: raw });
    }
  }
  return rows;
}
