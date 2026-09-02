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
  // runReconciliation with requireAlertSink so a missing alert channel fails preflight.
  alerts?: OperationalAlertSink;
}

export type SecretLookup = (name: string) => string | undefined | Promise<string | undefined>;
export type ReservaClock = () => Date;
export interface ReservaLogger {
  info?(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
  error?(message: string, data?: Record<string, unknown>): void;
}

// The one admin auth port shape, shared by ReservaContext.adminAuth and
// CloudflareReservaRuntimeOptions.adminAuth. `context` is the already-built ReservaContext, so a
// custom implementation reads `context.secrets`/`context.config` without bindings plumbing of its own.
export type AdminAuth = (request: Request, context: ReservaContext) => Promise<AdminIdentity | null>;

export interface ReservaContext {
  config: ClientConfig;
  // The pristine file config, set when DB-backed setting overrides are merged into `config`. The
  // admin settings page reads it to show what each value falls back to; absent when no overrides exist.
  baseConfig?: ClientConfig;
  db: D1Database;
  repo: BookingRepository;
  providers: ReservaProviders;
  cache?: ReservaCache;
  secrets?: SecretLookup;
  clock: ReservaClock;
  logger: ReservaLogger;
  // In-process booking-event listeners. Validated (names, uniqueness, subscribed events) when the
  // context is built, so a typo fails at startup rather than silently never firing.
  hooks?: readonly BookingEventHook[];
  // The one admin auth port: `null` means unauthorized. Cloudflare Access is the default
  // implementation, auto-wired when `config.admin.access` is configured; a consumer can instead
  // supply this exact function shape as a custom strategy — there is only ever one admin auth path.
  adminAuth?: AdminAuth;
  waitUntil?: (promise: Promise<unknown>) => void;
  confirmationLocks?: Map<string, Promise<void>>;
  // Resolved (prefix-applied) route paths + group flags, so handlers that render links/redirects
  // agree with wherever the integration actually mounted routes. Defaulted here; route entrypoints
  // overwrite it with the real per-build value since a runtime module can't know routePrefix itself.
  routeConfig: ReservaResolvedRouteConfig;
  // The viewer's forced light/dark choice, parsed from the bk_theme cookie by createRouteContext so
  // every server-rendered page can set <html data-theme> up front. Absent = follow the OS.
  viewerTheme?: ThemePreference;
}

// The unprefixed, all-groups-enabled default for any context built without an explicit routeConfig,
// so adding this field can't change existing behavior.
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
    // Threads the same secrets accessor the rest of ReservaContext uses through to the repo, so it
    // can resolve the optional RESERVA_TOKEN_ENC_KEY — repo.ts can't import SecretLookup from here
    // since the reverse import would be circular.
    repo: input.repo ?? createBookingRepository(input.db, input.secrets),
    clock: input.clock ?? (() => new Date()),
    logger: input.logger ?? console,
    providers: input.providers,
    confirmationLocks: input.confirmationLocks ?? new Map(),
    routeConfig: input.routeConfig ?? defaultRouteConfig,
  };
}

// The shared-secret alternative to a per-booking operator token on the operator endpoints. Read
// through the same SecretLookup every other secret uses; a deployment must still list it in the
// runtime's `secretBindings`. Lives here so the runtime layer can default to it without importing a handler.
export const OPERATOR_SECRET_NAME = 'RESERVA_OPERATOR_SECRET';

export async function getSecret(context: ReservaContext, name: string): Promise<string | undefined> {
  return context.secrets ? context.secrets(name) : undefined;
}

export function nowIso(context: ReservaContext): string {
  return context.clock().toISOString();
}
