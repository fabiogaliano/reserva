import type { D1Database } from '@cloudflare/workers-types';
import type { AdminIdentity } from './access.js';
import { validateConfig, type ClientConfig } from './core/config.js';
import type {
  BookingEventHook,
  CalendarProvider,
  EmailProvider,
  OperationalAlertSink,
  PaymentProvider,
} from './core/events.js';
import { validateBookingEventHooks } from './core/events.js';
import { createBookingRepository, type BookingRepository } from './repo.js';
import { resolvedRoutePaths, type ReservaResolvedRouteConfig } from './routes-manifest.js';
import type { ThemePreference } from './ui/theme.js';

export interface ReservaCache {
  match(request: any): Promise<Response | undefined | null>;
  put(request: any, response: any): Promise<void>;
}

export interface ReservaProviders {
  payments: PaymentProvider;
  calendar?: CalendarProvider;
  email?: EmailProvider;
  // Optional for HTTP-only/test contexts. Production scheduled entrypoints should call
  // runReconciliation with requireAlertSink so a missing central alert channel fails preflight;
  // pending revisions are never acknowledged when this provider is absent.
  alerts?: OperationalAlertSink;
}

export type SecretLookup = (name: string) => string | undefined | Promise<string | undefined>;
export type ReservaClock = () => Date;
export interface ReservaLogger {
  info?(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
  error?(message: string, data?: Record<string, unknown>): void;
}

// The one admin auth port shape, shared verbatim by
// ReservaContext.adminAuth and CloudflareReservaRuntimeOptions.adminAuth (runtime-context.ts) —
// one shared declaration, not a duplicated custom-auth marker. `context` is the already-built
// ReservaContext, so a custom implementation can read `context.secrets`/`context.config` without
// bindings plumbing of its own.
export type AdminAuth = (request: Request, context: ReservaContext) => Promise<AdminIdentity | null>;

export interface ReservaContext {
  config: ClientConfig;
  // The pristine file config, set by createRouteContext when DB-backed setting overrides were
  // merged into `config` (core/settings.ts). The admin settings page reads it to show what each
  // value falls back to; absent when no overrides exist.
  baseConfig?: ClientConfig;
  db: D1Database;
  repo: BookingRepository;
  providers: ReservaProviders;
  cache?: ReservaCache;
  secrets?: SecretLookup;
  clock: ReservaClock;
  logger: ReservaLogger;
  // In-process booking-event listeners registered by the consumer's
  // runtime module. Validated (names, uniqueness, subscribed events) when the context is built, so
  // a typo fails at startup rather than by silently never firing.
  hooks?: readonly BookingEventHook[];
  // The admin auth port. `null` means unauthorized. Cloudflare Access is the default
  // implementation (cloudflareAccessAdminAuth, src/access.ts), auto-wired by
  // defineCloudflareReservaRuntime only when `config.admin.access` is configured; a consumer
  // registers a custom strategy by passing this exact function shape as `adminAuth` to the runtime
  // factory — there is no second `kind: 'custom'` marker to keep in sync with it. Every admin/ops
  // handler reaches this only through the one shared gate (accessAllowed, src/admin-access.ts),
  // which also treats a throw as unauthorized rather than a 500 — fail-closed either way.
  // AdminIdentity.subject is what the admin CSRF token binds to (src/admin-csrf.ts): the default
  // Access implementation resolves it to the verified JWT subject, while a custom implementation
  // with no per-user identity to bind may return the documented empty-string subject — the
  // resulting token is session-agnostic (interchangeable across every admin-authorized caller) but
  // not weaker, since it's still HMAC'd with the real RESERVA_CSRF_SECRET and still gated by the
  // same-origin check first.
  adminAuth?: AdminAuth;
  waitUntil?: (promise: Promise<unknown>) => void;
  confirmationLocks?: Map<string, Promise<void>>;
  // Resolved (prefix-applied) route paths + group flags, so handlers that render links/redirects
  // (e.g. the admin page's manage links) agree with wherever the integration actually mounted
  // routes. Always populated by createReservaContext (defaulted below) — route entrypoints then
  // overwrite it with the real per-build value from `virtual:reserva/config` (see
  // src/routes/route-context.ts), since a user-owned runtime module has no way to know the
  // integration's `routePrefix`/`routes` options itself.
  routeConfig: ReservaResolvedRouteConfig;
  // The viewer's forced light/dark choice, parsed from the bk_theme cookie by createRouteContext so
  // every server-rendered page can set <html data-theme> up front. Absent = follow the OS.
  viewerTheme?: ThemePreference;
}

// The unprefixed, all-groups-enabled default: today's behavior for any context built without an
// explicit routeConfig (every existing test and any runtime module that doesn't go through
// src/routes/route-context.ts), so adding this field can't change existing behavior.
const defaultRouteConfig: ReservaResolvedRouteConfig = { paths: resolvedRoutePaths(), groups: { admin: true, ops: true, manage: true } };

export interface ReservaContextInput extends Omit<ReservaContext, 'repo' | 'clock' | 'logger' | 'providers' | 'routeConfig'> {
  providers: ReservaProviders;
  repo?: BookingRepository;
  clock?: ReservaClock;
  logger?: ReservaLogger;
  routeConfig?: ReservaResolvedRouteConfig;
}

export function createReservaContext(input: ReservaContextInput): ReservaContext {
  validateBookingEventHooks(input.hooks ?? []);
  return {
    ...input,
    config: validateConfig(input.config),
    // Threads the same secrets accessor the rest of ReservaContext uses through to
    // the repo, so it can resolve the optional RESERVA_TOKEN_ENC_KEY (src/repo.ts) — repo.ts
    // can't import SecretLookup from here (this module already imports createBookingRepository
    // from repo.ts, and the reverse import would be circular).
    repo: input.repo ?? createBookingRepository(input.db, input.secrets),
    clock: input.clock ?? (() => new Date()),
    logger: input.logger ?? console,
    providers: input.providers,
    confirmationLocks: input.confirmationLocks ?? new Map(),
    routeConfig: input.routeConfig ?? defaultRouteConfig,
  };
}

// The shared-secret alternative to a per-booking operator token on the operator endpoints. Declared
// in the astro:env schema (src/integration.ts) and read through the same SecretLookup every other
// secret uses; a deployment must still list it in the runtime's `secretBindings`. It lives beside
// SecretLookup rather than in the handler that checks it, so the runtime layer can default
// `secretBindings` to it without importing a request handler.
export const OPERATOR_SECRET_NAME = 'RESERVA_OPERATOR_SECRET';

export async function getSecret(context: ReservaContext, name: string): Promise<string | undefined> {
  return context.secrets ? context.secrets(name) : undefined;
}

export function nowIso(context: ReservaContext): string {
  return context.clock().toISOString();
}
