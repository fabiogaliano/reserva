import type { D1Database } from '@cloudflare/workers-types';
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
  db: D1Database;
  repo: BookingRepository;
  providers: BookkitProviders;
  cache?: BookkitCache;
  secrets?: SecretLookup;
  clock: BookkitClock;
  logger: BookkitLogger;
  verifyAccess?: (request: Request) => boolean | Promise<boolean>;
  waitUntil?: (promise: Promise<unknown>) => void;
  refundedPayments?: Set<string>;
  confirmationLocks?: Map<string, Promise<void>>;
}

export interface BookkitContextInput extends Omit<BookkitContext, 'repo' | 'clock' | 'logger' | 'providers'> {
  providers: BookkitProviders;
  repo?: BookingRepository;
  clock?: BookkitClock;
  logger?: BookkitLogger;
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
    refundedPayments: input.refundedPayments ?? new Set(),
    confirmationLocks: input.confirmationLocks ?? new Map(),
  };
}

export async function getSecret(context: BookkitContext, name: string): Promise<string | undefined> {
  return context.secrets ? context.secrets(name) : undefined;
}

export function nowIso(context: BookkitContext): string {
  return context.clock().toISOString();
}
