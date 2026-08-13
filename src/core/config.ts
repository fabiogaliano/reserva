import { z } from 'astro/zod';

export type PickupType = 'default' | 'custom';
export type PaymentMethod = 'card' | 'mb_way';

export interface ScheduleRule {
  from?: string;
  to?: string;
  days: number[];
  firstStart: string;
  lastStart: string;
  intervalMin: number;
}

export interface PricingRule {
  maxPeople: number;
  pickup: PickupType;
  priceCents: number;
}

export interface MeetingPoint {
  id: string;
  label: string;
  mapsUrl: string;
}

export interface TourConfig {
  durationMin: number;
  turnaroundMin: number;
  schedule: ScheduleRule[];
  pricing: PricingRule[];
  occupancyFor?: (people: number) => number;
  // Plan 017 (design decision 1): exactly one of meetingPoint (single-point shorthand) or
  // meetingPoints (multi-point) may be declared — validateConfig rejects both/neither and
  // normalizes whichever is given into the canonical meetingPoints array below (clearing the
  // shorthand, so it never survives validation), and every internal reader goes through
  // resolveMeetingPoint instead of branching on which shape a tour used.
  meetingPoint?: {
    label: string;
    mapsUrl: string;
  };
  meetingPoints?: MeetingPoint[];
}

export interface ClientConfig {
  business: {
    name: string;
    shortCode: string;
    url: string;
    timezone: string;
    currency: 'eur';
    contact: {
      email: string;
      phone: string;
      whatsapp?: string;
    };
  };
  fleet: {
    defaultCapacity: number;
  };
  admin: {
    accessTeamDomain: string;
    accessAud: string;
  };
  tours: Record<string, TourConfig>;
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
    // link keeps working through the whole pre-tour period plus a post-tour grace window
    // (late reschedules, refund follow-up, review requests). Optional — defaults to
    // DEFAULT_TOKEN_EXPIRY_DAYS below when unset, so existing deployments don't need a config
    // change to pick up expiry.
    tokenExpiryDays?: number;
  };
  locales: {
    supported: string[];
    default: string;
  };
  payments: {
    methods: PaymentMethod[];
  };
  legal: {
    termsUrl: string;
  };
  ui?: {
    // Per-locale overrides for bookkit's rendered copy, merged over the English defaults in
    // src/ui/messages.ts. Keys are locale tags ('pt', 'fr', …); values are partial message maps.
    messages?: Record<string, Record<string, string>>;
  };
}

export const stripeSupportedLocales = new Set([
  'auto', 'bg', 'cs', 'da', 'de', 'el', 'en', 'en-GB', 'es', 'es-419', 'et',
  'fi', 'fil', 'fr', 'fr-CA', 'he', 'hr', 'hu', 'id', 'it', 'ja', 'ko', 'lt',
  'lv', 'ms', 'mt', 'nb', 'nl', 'pl', 'pt', 'pt-BR', 'ro', 'ru', 'sk', 'sl',
  'sv', 'th', 'tr', 'uk', 'vi', 'zh', 'zh-HK', 'zh-TW',
]);

// BK-SEC-002: default for booking.tokenExpiryDays when a deployment doesn't set one — long
// enough to cover post-tour reschedules/refund disputes/review-request follow-ups without ever
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

const tourSchema = z.object({
  durationMin: z.number().int().positive(),
  turnaroundMin: z.number().int().nonnegative(),
  schedule: z.array(scheduleSchema).min(1),
  pricing: z.array(z.object({
    maxPeople: z.number().int().positive(),
    pickup: z.enum(['default', 'custom']),
    priceCents: z.number().int().nonnegative(),
  })).min(1),
  occupancyFor: z.custom<(people: number) => number>((value) => typeof value === 'function').optional(),
  meetingPoint: z.object({ label: z.string().min(1), mapsUrl: z.string().url() }).optional(),
  meetingPoints: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    mapsUrl: z.string().url(),
  })).min(1).optional(),
});

export const clientConfigSchema = z.object({
  business: z.object({
    name: z.string().min(1),
    shortCode: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,9}$/),
    url: z.string().url(),
    timezone: z.string().min(1),
    currency: z.literal('eur'),
    contact: z.object({
      email: z.string().email(),
      phone: z.string().min(1),
      whatsapp: z.string().optional(),
    }),
  }),
  fleet: z.object({ defaultCapacity: z.number().int().nonnegative() }),
  admin: z.object({
    accessTeamDomain: z.string().refine(isValidAccessTeamDomain, 'must be an HTTPS Cloudflare Access origin'),
    accessAud: z.string().min(1),
  }),
  tours: z.record(z.string(), tourSchema).refine((value) => Object.keys(value).length > 0, 'at least one tour is required'),
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
  payments: z.object({ methods: z.array(z.enum(['card', 'mb_way'])).min(1) }),
  legal: z.object({ termsUrl: z.string().url() }),
  ui: z.object({
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

function validateTour(tour: TourConfig, tourSlug: string, add: (path: (string | number)[], message: string) => void): void {
  const pricingBreakpoints: Record<PickupType, Map<number, number>> = {
    default: new Map(),
    custom: new Map(),
  };
  for (const [index, rule] of tour.pricing.entries()) {
    const previousIndex = pricingBreakpoints[rule.pickup].get(rule.maxPeople);
    if (previousIndex !== undefined) {
      add(
        ['tours', tourSlug, 'pricing', index],
        `tour ${tourSlug} pricing rule ${index} (pickup=${rule.pickup}, maxPeople=${rule.maxPeople}) duplicates and shadows rule ${previousIndex}; remove or change one breakpoint`,
      );
    } else {
      pricingBreakpoints[rule.pickup].set(rule.maxPeople, index);
    }
  }

  for (const [index, rule] of tour.schedule.entries()) {
    if (rule.from && !isValidMonthDay(rule.from)) {
      add(['tours', tourSlug, 'schedule', index, 'from'], 'must be a valid month-day');
    }
    if (rule.to && !isValidMonthDay(rule.to)) {
      add(['tours', tourSlug, 'schedule', index, 'to'], 'must be a valid month-day');
    }
    if (rule.firstStart > rule.lastStart) {
      add(['tours', tourSlug, 'schedule', index], 'firstStart must not be after lastStart');
    }
    if (rule.intervalMin > 24 * 60) {
      add(['tours', tourSlug, 'schedule', index, 'intervalMin'], 'intervalMin must be at most one day');
    }
  }

  const highest = Math.max(...tour.pricing.map((row) => row.maxPeople));
  const peopleValues = Array.from({ length: highest }, (_, index) => index + 1);
  for (const people of peopleValues) {
    for (const pickup of ['default', 'custom'] as const) {
      if (!tour.pricing.some((row) => row.pickup === pickup && people <= row.maxPeople)) {
        add(['tours', tourSlug, 'pricing'], `missing ${pickup} pricing for people=${people}`);
      }
    }
  }
  if (tour.occupancyFor) {
    for (const people of peopleValues) {
      try {
        const units = tour.occupancyFor(people);
        if (!Number.isInteger(units) || units < 1) {
          add(['tours', tourSlug, 'occupancyFor'], `occupancyFor(${people}) must return a positive integer`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        add(['tours', tourSlug, 'occupancyFor'], `occupancyFor(${people}) threw: ${message}`);
      }
    }
  }

  // Plan 017 (design decision 1): exactly one of meetingPoint/meetingPoints — two sources of
  // truth for where a tour departs from would let them silently disagree.
  if (tour.meetingPoint && tour.meetingPoints) {
    add(['tours', tourSlug], 'declare either meetingPoint or meetingPoints, not both');
  } else if (!tour.meetingPoint && !tour.meetingPoints) {
    add(['tours', tourSlug], 'must declare either meetingPoint or meetingPoints');
  } else if (tour.meetingPoints) {
    const seenIds = new Set<string>();
    for (const [index, point] of tour.meetingPoints.entries()) {
      if (seenIds.has(point.id)) {
        add(['tours', tourSlug, 'meetingPoints', index, 'id'], `duplicate meeting point id (${point.id}); ids must be unique within a tour`);
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
  if (config.booking.holdMinutes < 35) {
    add(['booking', 'holdMinutes'], 'must be at least 35 minutes');
  } else if (config.booking.holdMinutes > 1440) {
    // 1440 (not Stripe's exact 1445min cap) keeps expires_at 5 minutes under Stripe's 24h-from-
    // creation limit, since expires_at is computed from Bookkit's clock, not Stripe's — a
    // holdMinutes=1445 session would sit exactly on the edge and fail intermittently under clock
    // skew (see providers/stripe.ts expiresInMinutes).
    add(['booking', 'holdMinutes'], 'must be at most 1440 minutes (Stripe checkout sessions cannot stay open longer than 24 hours)');
  }
  if (!config.locales.supported.includes(config.locales.default)) {
    add(['locales', 'default'], 'must be included in locales.supported');
  }
  for (const [index, locale] of config.locales.supported.entries()) {
    if (!stripeSupportedLocales.has(locale)) {
      add(['locales', 'supported', index], `locale ${locale} is not supported by Stripe Checkout`);
    }
  }
  for (const [slug, tour] of Object.entries(config.tours)) {
    validateTour(tour, slug, add);
  }

  if (issues.length > 0) {
    const result = clientConfigSchema.superRefine((_, ctx) => {
      for (const issue of issues) addIssue(ctx, issue.path, issue.message);
    }).safeParse(input);
    if (!result.success) throw result.error;
  }
  for (const tour of Object.values(config.tours)) {
    tour.pricing.sort((a, b) => a.maxPeople - b.maxPeople);
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
    if (!tour.meetingPoints) {
      tour.meetingPoints = [{ id: 'default', ...tour.meetingPoint! }];
      delete tour.meetingPoint;
    }
  }
  return config;
}

export function peopleValuesForTour(tour: TourConfig): number[] {
  const highest = Math.max(...tour.pricing.map((row) => row.maxPeople), 0);
  return Array.from({ length: highest }, (_, index) => index + 1);
}

export function resolveTour(config: ClientConfig, tourSlug: string): TourConfig {
  const tour = config.tours[tourSlug];
  if (!tour) throw new Error(`Unknown tour: ${tourSlug}`);
  return tour;
}

// Plan 017 (design decision 1): id match wins; no id or an unknown id falls back to the first
// declared point. Tolerant of a raw (never-validated) tour — examples/smoke-site imports config
// directly for the widget (plan 017 STOP condition 2) — by deriving the single point from the
// meetingPoint shorthand when meetingPoints hasn't been normalized in yet.
export function resolveMeetingPoint(tour: TourConfig, meetingPointId?: string): MeetingPoint {
  const points = tour.meetingPoints ?? (tour.meetingPoint ? [{ id: 'default', ...tour.meetingPoint }] : []);
  if (points.length === 0) {
    throw new Error('tour declares no meeting points');
  }
  if (meetingPointId) {
    const match = points.find((point) => point.id === meetingPointId);
    if (match) return match;
  }
  return points[0]!;
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
  tour: TourConfig,
  meetingPointId: string | null,
  meetingPointLabel: string | null,
): { label: string; mapsUrl: string | null } {
  if (meetingPointId) {
    const points = tour.meetingPoints ?? (tour.meetingPoint ? [{ id: 'default', ...tour.meetingPoint }] : []);
    const match = points.find((point) => point.id === meetingPointId);
    if (match) return { label: match.label, mapsUrl: match.mapsUrl };
    return { label: meetingPointLabel ?? meetingPointId, mapsUrl: null };
  }
  const first = resolveMeetingPoint(tour);
  return { label: first.label, mapsUrl: first.mapsUrl };
}
