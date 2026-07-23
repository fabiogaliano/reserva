import type { D1Database } from '@cloudflare/workers-types';
import type { AccessClaims } from './access';
import { validateConfig, type ClientConfig } from './core/config';
import type {
  AnalyticsSink,
  CalendarProvider,
  EmailProvider,
  OpsSink,
  PaymentProvider,
} from './core/events';
import { noopAnalyticsSink } from './core/events';
import { createBookingRepository, type BookingRepository } from './repo';
import { resolvedRoutePaths, type BookkitResolvedRouteConfig } from './routes-manifest';
import type { ThemePreference } from './ui/theme';

export interface BookkitCache {
  match(request: any): Promise<Response | undefined | null>;
  put(request: any, response: any): Promise<void>;
}

export interface BookkitProviders {
  payments: PaymentProvider;
  calendar?: CalendarProvider;
  email?: EmailProvider;
  ops?: OpsSink;
  analytics?: AnalyticsSink;
}

export type SecretLookup = (name: string) => string | undefined | Promise<string | undefined>;
export type BookkitClock = () => Date;
export interface BookkitLogger {
  info?(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
  error?(message: string, data?: Record<string, unknown>): void;
}

export interface BookkitContext {
  config: ClientConfig;
  // The pristine file config, set by createRouteContext when DB-backed setting overrides were
  // merged into `config` (core/settings.ts). The admin settings page reads it to show what each
  // value falls back to; absent when no overrides exist.
  baseConfig?: ClientConfig;
  db: D1Database;
  repo: BookingRepository;
  providers: BookkitProviders;
  cache?: BookkitCache;
  secrets?: SecretLookup;
  clock: BookkitClock;
  logger: BookkitLogger;
  // The default Cloudflare Access wiring (runtime-context.ts) resolves to the verified JWT claims
  // (AccessClaims) rather than collapsing to a boolean, so the admin CSRF token (src/admin-csrf.ts)
  // can bind itself to a specific Access user. A caller-supplied verifyAccess is only contractually
  // required to return `boolean` (the supported API — see CloudflareBookkitRuntimeOptions.verifyAccess
  // in runtime-context.ts, which is boolean-only even for the Cloudflare runtime helper's own
  // override option), and a plain `true` carries no identity to bind a token to. accessAllowed
  // (src/handlers/index.ts) falls back to an empty/anonymous subject in that case rather than
  // inventing one — the resulting token is session-agnostic (interchangeable across every
  // Access-authorized caller) but not weaker: it's still HMAC'd with the real BOOKKIT_CSRF_SECRET
  // and still gated by the same-origin check, so it does not degrade to the accessAud-as-key
  // forgery BK-SEC-001 flagged (see src/admin-csrf.ts). Don't try to force per-user binding here —
  // there is no identity to bind to without extending the verifyAccess contract itself.
  verifyAccess?: (request: Request) => boolean | AccessClaims | Promise<boolean | AccessClaims>;
  waitUntil?: (promise: Promise<unknown>) => void;
  confirmationLocks?: Map<string, Promise<void>>;
  // Resolved (prefix-applied) route paths + group flags, so handlers that render links/redirects
  // (e.g. the admin page's manage links) agree with wherever the integration actually mounted
  // routes. Always populated by createBookkitContext (defaulted below) — route entrypoints then
  // overwrite it with the real per-build value from `virtual:bookkit/config` (see
  // src/routes/route-context.ts), since a user-owned runtime module has no way to know the
  // integration's `routePrefix`/`routes` options itself.
  routeConfig: BookkitResolvedRouteConfig;
  // The viewer's forced light/dark choice, parsed from the bk_theme cookie by createRouteContext so
  // every server-rendered page can set <html data-theme> up front. Absent = follow the OS.
  viewerTheme?: ThemePreference;
}

// The unprefixed, all-groups-enabled default: today's behavior for any context built without an
// explicit routeConfig (every existing test and any runtime module that doesn't go through
// src/routes/route-context.ts), so adding this field can't change existing behavior.
const defaultRouteConfig: BookkitResolvedRouteConfig = { paths: resolvedRoutePaths(), groups: { admin: true, ops: true } };

export interface BookkitContextInput extends Omit<BookkitContext, 'repo' | 'clock' | 'logger' | 'providers' | 'routeConfig'> {
  providers: BookkitProviders;
  repo?: BookingRepository;
  clock?: BookkitClock;
  logger?: BookkitLogger;
  routeConfig?: BookkitResolvedRouteConfig;
}

export function createBookkitContext(input: BookkitContextInput): BookkitContext {
  return {
    ...input,
    config: validateConfig(input.config),
    repo: input.repo ?? createBookingRepository(input.db),
    clock: input.clock ?? (() => new Date()),
    logger: input.logger ?? console,
    providers: {
      ...input.providers,
      analytics: input.providers.analytics ?? noopAnalyticsSink,
    },
    confirmationLocks: input.confirmationLocks ?? new Map(),
    routeConfig: input.routeConfig ?? defaultRouteConfig,
  };
}

export async function getSecret(context: BookkitContext, name: string): Promise<string | undefined> {
  return context.secrets ? context.secrets(name) : undefined;
}

export function nowIso(context: BookkitContext): string {
  return context.clock().toISOString();
}
