// The browser-safe half of the package: everything a booking funnel needs to call the API with the
// same types the handlers answer with. Imports nothing but `src/core/api.ts` (types plus its runtime
// constants) and the Astro-free route pattern table, so bundling it pulls in no Astro, Node or
// Cloudflare code.

import {
  isApiErrorCode,
  MANAGE_TOKEN_HEADER,
  MAX_AVAILABILITY_RANGE_DAYS,
  type ApiErrorCode,
  type ApiErrorDetails,
  type ApiErrorEnvelope,
  type AvailabilityResponse,
  type CancelRequest,
  type CatalogResponse,
  type CheckoutRequest,
  type CheckoutResponse,
  type ManageActionResponse,
  type ManageResponse,
  type QuoteRequest,
  type OpsHealthResponse,
  type QuoteResponse,
  type ReconciliationSummary,
  type RescheduleRequest,
  type StatusResponse,
} from '../core/api.js';
import { resolvedRoutePaths, type ReservaRoutePaths } from '../core/route-paths.js';

export { API_ERROR_CODES, isApiErrorCode, MANAGE_TOKEN_HEADER, MAX_AVAILABILITY_RANGE_DAYS } from '../core/api.js';
export * from './availability.js';

// Only the routes a browser client may legitimately call: the payment webhook, the asset routes and
// the server-rendered pages are not part of this surface.
export type ReservaClientRouteId =
  | 'availability'
  | 'checkout'
  | 'quote'
  | 'catalog'
  | 'status'
  | 'manageApi'
  | 'cancel'
  | 'reschedule'
  | 'operatorCancel'
  | 'operatorReschedule'
  | 'operatorNoShow'
  | 'opsHealth'
  | 'reconcile';

// Structurally the same shape `virtual:reserva/config`'s `routes.paths` carries, narrowed to the
// callable routes — so an Astro consumer can pass `virtualConfig.routes.paths` straight in.
export type ReservaClientPaths = Pick<ReservaRoutePaths, ReservaClientRouteId>;

export interface ReservaClientOptions {
  // The deployment's resolved route table (from `virtual:reserva/config`). Mutually exclusive with
  // `base`: pass this when the site mounts Reserva under a `routePrefix` or on custom paths.
  paths?: Partial<ReservaClientPaths>;
  // A plain origin/prefix the default patterns hang off ('' for a same-origin default mount,
  // 'https://booking.example.com' for a cross-origin funnel, which only works once the funnel's
  // origin is listed in the deployment's `routes.cors.origins`).
  base?: string;
  fetch?: typeof fetch;
  // Operator secret for the `operator*` and `ops*` routes; never needed by a customer funnel.
  bearer?: string;
}

// Every failure a call can produce, including a network error, so a caller has exactly one thing to
// catch. `status` is 0 when the request never reached the server.
export class ReservaApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details: ApiErrorDetails | undefined;

  constructor(status: number, code: ApiErrorCode, message: string, details?: ApiErrorDetails) {
    super(message);
    this.name = 'ReservaApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isReservaApiError(value: unknown): value is ReservaApiError {
  return value instanceof ReservaApiError;
}

export interface ReservaRequestInit {
  signal?: AbortSignal;
}

export interface AvailabilityQuery {
  serviceSlug: string;
  // Omitted means "a party of one" — the same default the availability handler applies.
  quantity?: number;
  from: string;
  to: string;
  // The booking's own manage token (customer or operator): leaves that booking out of the count,
  // for a reschedule picker. Sent as a header, never in the URL.
  manageToken?: string;
}

export interface OperatorNoShowRequest {
  operatorToken?: string;
  bookingId?: string;
}

export interface ReservaClient {
  catalog(query?: { locale?: string }, init?: ReservaRequestInit): Promise<CatalogResponse>;
  availability(query: AvailabilityQuery, init?: ReservaRequestInit): Promise<AvailabilityResponse>;
  quote(body: QuoteRequest, init?: ReservaRequestInit): Promise<QuoteResponse>;
  checkout(body: CheckoutRequest, init?: ReservaRequestInit): Promise<CheckoutResponse>;
  status(query: { sessionId: string }, init?: ReservaRequestInit): Promise<StatusResponse>;
  manage(query: { token: string }, init?: ReservaRequestInit): Promise<ManageResponse>;
  cancel(body: CancelRequest, init?: ReservaRequestInit): Promise<ManageActionResponse>;
  reschedule(body: RescheduleRequest, init?: ReservaRequestInit): Promise<ManageActionResponse>;
  operator: {
    cancel(body: CancelRequest, init?: ReservaRequestInit): Promise<ManageActionResponse>;
    reschedule(body: RescheduleRequest, init?: ReservaRequestInit): Promise<ManageActionResponse>;
    noShow(body: OperatorNoShowRequest, init?: ReservaRequestInit): Promise<ManageActionResponse>;
  };
  opsHealth(init?: ReservaRequestInit): Promise<OpsHealthResponse>;
  opsReconcile(body?: { sourceLimit?: number; alertLimit?: number }, init?: ReservaRequestInit): Promise<ReconciliationSummary>;
}

function envelopeError(status: number, payload: unknown): ReservaApiError {
  const envelope = payload as Partial<ApiErrorEnvelope> | null;
  const error = envelope && typeof envelope === 'object' ? envelope.error : undefined;
  if (error && isApiErrorCode(error.code) && typeof error.message === 'string') {
    return new ReservaApiError(status, error.code, error.message, error.details);
  }
  // A non-2xx that isn't a Reserva envelope is an infrastructure answer (a proxy, an edge error
  // page): reported with the transport status so a caller can still distinguish 404 from 503.
  return new ReservaApiError(status, 'internal_error', `Request failed with status ${status}`);
}

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function addDays(date: string, days: number): string {
  const probe = new Date(`${date}T00:00:00Z`);
  probe.setUTCDate(probe.getUTCDate() + days);
  return probe.toISOString().slice(0, 10);
}

// Consecutive ranges of at most MAX_AVAILABILITY_RANGE_DAYS, so a caller asking for a whole horizon
// still gets one merged answer. Anything that isn't a plain date pair is sent as-is for the server
// to reject with its own validation error.
function availabilityChunks(from: string, to: string): Array<{ from: string; to: string }> {
  if (!DATE_KEY.test(from) || !DATE_KEY.test(to) || Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`))) {
    return [{ from, to }];
  }
  const chunks: Array<{ from: string; to: string }> = [];
  let cursor = from;
  do {
    const end = addDays(cursor, MAX_AVAILABILITY_RANGE_DAYS - 1);
    const chunkTo = end < to ? end : to;
    chunks.push({ from: cursor, to: chunkTo });
    cursor = addDays(chunkTo, 1);
  } while (cursor <= to);
  return chunks;
}

export function createReservaClient(options: ReservaClientOptions = {}): ReservaClient {
  if (options.paths && options.base !== undefined) {
    throw new Error('createReservaClient: pass either `paths` or `base`, not both');
  }
  // `https://booking.example.com/` and `https://booking.example.com` are the same base; without the
  // trim every default path would start with `//`.
  const defaults = resolvedRoutePaths((options.base ?? '').replace(/\/+$/, ''));
  const pathFor = (id: ReservaClientRouteId): string => options.paths?.[id] ?? defaults[id];
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  interface CallOptions {
    method: 'GET' | 'POST';
    body?: unknown;
    // Reads whose answer changes under the caller's feet (a slot list, a payment status, a booking
    // record) must never come from the bfcache or a shared HTTP cache.
    noStore?: boolean;
    authorized?: boolean;
    headers?: Record<string, string>;
    init?: ReservaRequestInit;
  }

  async function call<T>(url: string, callOptions: CallOptions): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', ...callOptions.headers };
    if (callOptions.body !== undefined) headers['content-type'] = 'application/json';
    if (callOptions.authorized && options.bearer) headers.authorization = `Bearer ${options.bearer}`;
    let response: Response;
    try {
      response = await doFetch(url, {
        method: callOptions.method,
        headers,
        ...(callOptions.body === undefined ? {} : { body: JSON.stringify(callOptions.body) }),
        ...(callOptions.noStore ? { cache: 'no-store' as const } : {}),
        ...(callOptions.init?.signal ? { signal: callOptions.init.signal } : {}),
      });
    } catch (cause) {
      // Status 0 is the wire's own failure (offline, DNS, CORS, abort): there is no HTTP answer to
      // report, and the caller still gets one error type to catch.
      throw new ReservaApiError(0, 'internal_error', cause instanceof Error ? cause.message : 'Network request failed');
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (!response.ok) throw envelopeError(response.status, null);
      throw new ReservaApiError(response.status, 'internal_error', 'The response was not valid JSON');
    }
    if (!response.ok) throw envelopeError(response.status, payload);
    return payload as T;
  }

  return {
    catalog(query = {}, init) {
      return call<CatalogResponse>(pathFor('catalog') + queryString({ locale: query.locale }), { method: 'GET', ...(init ? { init } : {}) });
    },
    async availability(query, init) {
      const responses = await Promise.all(availabilityChunks(query.from, query.to).map((range) => call<AvailabilityResponse>(
        pathFor('availability') + queryString({
          serviceSlug: query.serviceSlug,
          ...(query.quantity === undefined ? {} : { quantity: query.quantity }),
          from: range.from,
          to: range.to,
        }),
        {
          method: 'GET',
          noStore: true,
          ...(query.manageToken ? { headers: { [MANAGE_TOKEN_HEADER]: query.manageToken } } : {}),
          ...(init ? { init } : {}),
        },
      )));
      // availabilityChunks always yields at least one range.
      const first = responses[0]!;
      return responses.length === 1 ? first : { ...first, days: responses.flatMap((response) => response.days) };
    },
    quote(body, init) {
      return call<QuoteResponse>(pathFor('quote'), { method: 'POST', body, ...(init ? { init } : {}) });
    },
    checkout(body, init) {
      return call<CheckoutResponse>(pathFor('checkout'), { method: 'POST', body, ...(init ? { init } : {}) });
    },
    status(query, init) {
      return call<StatusResponse>(pathFor('status') + queryString({ sessionId: query.sessionId }), { method: 'GET', noStore: true, ...(init ? { init } : {}) });
    },
    manage(query, init) {
      return call<ManageResponse>(pathFor('manageApi') + queryString({ token: query.token }), { method: 'GET', noStore: true, ...(init ? { init } : {}) });
    },
    cancel(body, init) {
      return call<ManageActionResponse>(pathFor('cancel'), { method: 'POST', body, ...(init ? { init } : {}) });
    },
    reschedule(body, init) {
      return call<ManageActionResponse>(pathFor('reschedule'), { method: 'POST', body, ...(init ? { init } : {}) });
    },
    operator: {
      cancel(body, init) {
        return call<ManageActionResponse>(pathFor('operatorCancel'), { method: 'POST', body, authorized: true, ...(init ? { init } : {}) });
      },
      reschedule(body, init) {
        return call<ManageActionResponse>(pathFor('operatorReschedule'), { method: 'POST', body, authorized: true, ...(init ? { init } : {}) });
      },
      noShow(body, init) {
        return call<ManageActionResponse>(pathFor('operatorNoShow'), { method: 'POST', body, authorized: true, ...(init ? { init } : {}) });
      },
    },
    opsHealth(init) {
      return call<OpsHealthResponse>(pathFor('opsHealth'), { method: 'GET', noStore: true, authorized: true, ...(init ? { init } : {}) });
    },
    opsReconcile(body = {}, init) {
      return call<ReconciliationSummary>(pathFor('reconcile'), { method: 'POST', body, authorized: true, ...(init ? { init } : {}) });
    },
  };
}
