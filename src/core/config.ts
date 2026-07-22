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

export interface TourConfig {
  durationMin: number;
  turnaroundMin: number;
  schedule: ScheduleRule[];
  pricing: PricingRule[];
  occupancyFor?: (people: number) => number;
  meetingPoint: {
    label: string;
    mapsUrl: string;
  };
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
    maxHoldsPerIp?: number;
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
  meetingPoint: z.object({ label: z.string().min(1), mapsUrl: z.string().url() }),
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
    maxHoldsPerIp: z.number().int().positive().optional(),
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
