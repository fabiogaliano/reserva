// A minimal Stripe REST client over `fetch` and WebCrypto. The official SDK is ~750 KB of JavaScript
// that a Worker must parse and evaluate on the first payment request of every isolate, which alone
// exceeds the Workers Free plan's 10 ms CPU budget; this adapter only ever needs six endpoints.
// Behaviour mirrors stripe-node 22 (API version, form encoding, retries, error classes, webhook
// signature scheme) so swapping it in changes nothing Stripe or Reserva can observe.

// The version stripe-node 22.5 pins by default: responses keep exactly the shape the SDK returned.
export const STRIPE_API_VERSION = '2026-07-29.dahlia';
const STRIPE_API_BASE = 'https://api.stripe.com';
// stripe-node's defaults on Workers: two retries, 0.5 s initial backoff capped at 5 s, 80 s timeout.
const MAX_NETWORK_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 80_000;
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

export interface StripeCheckoutCustomFieldParams {
  key: string;
  label: { type: 'custom'; custom: string };
  type: 'text' | 'numeric' | 'dropdown';
  optional?: boolean;
  numeric?: { maximum_length?: number; minimum_length?: number };
}

export interface StripeCheckoutSessionCreateParams {
  mode: 'payment';
  line_items: Array<{
    quantity: number;
    price_data: { currency: string; unit_amount: number; product_data: { name: string; description?: string } };
  }>;
  expires_at?: number;
  locale?: string;
  excluded_payment_method_types?: string[];
  submit_type?: 'auto' | 'book' | 'donate' | 'pay' | 'subscribe';
  phone_number_collection?: { enabled: boolean };
  metadata?: Record<string, string>;
  payment_intent_data?: { metadata?: Record<string, string> };
  success_url?: string;
  cancel_url?: string;
  custom_fields?: StripeCheckoutCustomFieldParams[];
  consent_collection?: { terms_of_service?: 'none' | 'required' };
}

// Required-ness follows stripe-node's own types: Stripe always sends these fields, often as null.
export interface StripeCheckoutSession {
  id: string;
  object?: 'checkout.session';
  url: string | null;
  status: 'open' | 'complete' | 'expired' | null;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  amount_total: number | null;
  currency: string | null;
  payment_intent: string | { id: string } | null;
  metadata: Record<string, string> | null;
  expires_at: number;
  customer_details: { name: string | null; email: string | null; phone: string | null } | null;
  custom_fields: Array<{
    key: string;
    type: string;
    text?: { value: string | null } | null;
    numeric?: { value: string | null } | null;
  }>;
}

export interface StripeRefundCreateParams {
  payment_intent: string;
  amount?: number;
  metadata?: Record<string, string>;
}

export interface StripeRefundListParams {
  payment_intent?: string;
  limit?: number;
}

export interface StripeRefund {
  id: string;
  object?: 'refund';
  amount: number;
  status: string | null;
  currency?: string;
  payment_intent?: string | { id: string } | null;
  metadata?: Record<string, string> | null;
}

export interface StripeList<T> {
  object?: 'list';
  data: T[];
  has_more?: boolean;
}

export interface StripePaymentIntent {
  id: string;
  object?: 'payment_intent';
  status?: string;
}

export interface StripeDispute {
  id: string;
  object?: 'dispute';
  status: string;
  created?: number;
}

export interface StripeEvent {
  id: string;
  object?: string;
  type: string;
  created?: number;
  data: { object: unknown };
}

export interface StripeRequestOptions {
  idempotencyKey?: string;
}

// The shape of an error body Stripe returns, plus the transport facts the SDK attaches to it.
interface RawStripeError {
  type?: string;
  code?: string;
  message?: string;
  param?: string;
  decline_code?: string;
  doc_url?: string;
  statusCode?: number;
  requestId?: string;
  headers?: Record<string, string>;
  detail?: unknown;
}

// Same fields and class names as stripe-node's errors, so anything that inspects `type`, `code`,
// `statusCode` or `rawType` — including code written against an injected SDK client — keeps working.
export class StripeError extends Error {
  readonly type: string;
  readonly raw: RawStripeError;
  readonly rawType: string | undefined;
  readonly code: string | undefined;
  readonly param: string | undefined;
  readonly decline_code: string | undefined;
  readonly doc_url: string | undefined;
  readonly statusCode: number | undefined;
  readonly requestId: string | undefined;
  readonly headers: Record<string, string> | undefined;
  readonly detail: unknown;

  constructor(raw: RawStripeError = {}) {
    super(raw.message ?? '');
    this.type = new.target.name;
    this.name = new.target.name;
    this.raw = raw;
    this.rawType = raw.type;
    this.code = raw.code;
    this.param = raw.param;
    this.decline_code = raw.decline_code;
    this.doc_url = raw.doc_url;
    this.statusCode = raw.statusCode;
    this.requestId = raw.requestId;
    this.headers = raw.headers;
    this.detail = raw.detail;
  }
}
export class StripeCardError extends StripeError {}
export class StripeInvalidRequestError extends StripeError {}
export class StripeAuthenticationError extends StripeError {}
export class StripePermissionError extends StripeError {}
export class StripeRateLimitError extends StripeError {}
export class StripeIdempotencyError extends StripeError {}
export class StripeAPIError extends StripeError {}
export class StripeConnectionError extends StripeError {}
export class StripeSignatureVerificationError extends StripeError {}

// stripe-node's generateV1Error: the class follows the HTTP status, not the body's `type`.
export function stripeErrorFromResponse(raw: RawStripeError): StripeError {
  const status = raw.statusCode;
  if (status === 429 || (status === 400 && raw.code === 'rate_limit')) return new StripeRateLimitError(raw);
  if (status === 400 || status === 404) {
    return raw.type === 'idempotency_error' ? new StripeIdempotencyError(raw) : new StripeInvalidRequestError(raw);
  }
  if (status === 401) return new StripeAuthenticationError(raw);
  if (status === 402) return new StripeCardError(raw);
  if (status === 403) return new StripePermissionError(raw);
  return new StripeAPIError(raw);
}

// qs-style encoding exactly as stripe-node sends it: nested objects as `a[b]`, arrays indexed as
// `a[0]`, brackets left readable, and the RFC 3986 reserved characters qs escapes that
// encodeURIComponent does not. Byte-identical bodies matter: Stripe replays an idempotent request
// only when the retry's parameters match the original.
export function encodeStripeForm(data: object): string {
  const pairs: string[] = [];
  const encodeValue = (value: string) => encodeURIComponent(value)
    .replace(/!/g, '%21').replace(/\*/g, '%2A').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/'/g, '%27')
    .replace(/%5B/g, '[').replace(/%5D/g, ']');
  const encode = (key: string, value: unknown): void => {
    if (value === undefined) return;
    if (value === null || typeof value !== 'object' || value instanceof Date) {
      const text = value instanceof Date ? String(Math.floor(value.getTime() / 1000)) : value === null ? '' : String(value);
      pairs.push(`${encodeValue(key)}=${encodeValue(text)}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => encode(`${key}[${index}]`, item));
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) encode(`${key}[${childKey}]`, childValue);
  };
  for (const [key, value] of Object.entries(data)) encode(key, value);
  return pairs.join('&');
}

// stripe-node's _shouldRetry: connection failures, a 409 conflict and 5xx are transient unless
// Stripe says otherwise in `stripe-should-retry`.
function shouldRetry(response: Response | null, retries: number): boolean {
  if (retries >= MAX_NETWORK_RETRIES) return false;
  if (!response) return true;
  const hint = response.headers.get('stripe-should-retry');
  if (hint === 'false') return false;
  if (hint === 'true') return true;
  return response.status === 409 || response.status >= 500;
}

function retryDelayMs(retries: number): number {
  const base = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** (retries - 1), MAX_RETRY_DELAY_MS);
  return Math.max(INITIAL_RETRY_DELAY_MS, base * 0.5 * (1 + Math.random()));
}

function headersObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => { result[key] = value; });
  return result;
}

export interface StripeFetchClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface StripeApiClient {
  request<T>(method: 'GET' | 'POST', path: string, params?: object, options?: StripeRequestOptions): Promise<T>;
}

export function createStripeApiClient(secretKey: string, options: StripeFetchClientOptions = {}): StripeApiClient {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return {
    async request<T>(method: 'GET' | 'POST', path: string, params: object = {}, requestOptions: StripeRequestOptions = {}): Promise<T> {
      const encoded = encodeStripeForm(params);
      const url = `${STRIPE_API_BASE}${path}${method === 'GET' && encoded ? `?${encoded}` : ''}`;
      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_API_VERSION,
        'User-Agent': 'Reserva (+https://github.com/fabiogaliano/reserva)',
      };
      // Like stripe-node: a retried POST without a caller key still needs one, or a retry after a
      // lost response could perform the action twice.
      const idempotencyKey = requestOptions.idempotencyKey
        ?? (method === 'POST' ? `reserva-retry-${crypto.randomUUID()}` : undefined);
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      const body = method === 'POST' ? encoded : undefined;

      for (let retries = 0; ; retries += 1) {
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method, headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
        } catch (error) {
          if (shouldRetry(null, retries)) {
            await sleep(retryDelayMs(retries + 1));
            continue;
          }
          throw new StripeConnectionError({
            message: `An error occurred with our connection to Stripe.${retries > 0 ? ` Request was retried ${retries} times.` : ''}`,
            detail: error,
          });
        }
        if (response.status >= 400 && shouldRetry(response, retries)) {
          await sleep(retryDelayMs(retries + 1));
          continue;
        }
        const requestId = response.headers.get('request-id') ?? undefined;
        let json: unknown;
        try {
          json = await response.json();
        } catch {
          throw new StripeAPIError({
            message: 'Invalid JSON received from the Stripe API',
            statusCode: response.status,
            ...(requestId ? { requestId } : {}),
          });
        }
        const errorBody = json && typeof json === 'object' ? (json as { error?: RawStripeError }).error : undefined;
        if (response.status >= 400 || errorBody) {
          throw stripeErrorFromResponse({
            ...(errorBody ?? { message: `Stripe responded with HTTP ${response.status}` }),
            statusCode: response.status,
            headers: headersObject(response.headers),
            ...(requestId ? { requestId } : {}),
          });
        }
        return json as T;
      }
    },
  };
}

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

// Stripe's v1 webhook scheme, as stripe-node's verifyHeaderAsync implements it: HMAC-SHA256 of
// `${t}.${payload}` keyed by the endpoint secret, any matching `v1=` entry accepted (Stripe sends
// several during a secret roll), and only an event older than the tolerance rejected.
// `crypto.subtle.verify` is the constant-time comparison.
export async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
  tolerance = STRIPE_WEBHOOK_TOLERANCE_SECONDS,
  nowMs: number = Date.now(),
): Promise<void> {
  const fail = (message: string): never => { throw new StripeSignatureVerificationError({ message }); };
  if (!payload) fail('No webhook payload was provided.');
  if (!header) fail('No stripe-signature header value was provided.');
  let timestamp = -1;
  const signatures: string[] = [];
  for (const item of header.split(',')) {
    const [key, value = ''] = item.split('=');
    if (key === 't') timestamp = Number.parseInt(value, 10);
    if (key === 'v1') signatures.push(value);
  }
  if (timestamp === -1 || Number.isNaN(timestamp)) fail('Unable to extract timestamp and signatures from header');
  if (signatures.length === 0) fail('No signatures found with expected scheme');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signed = encoder.encode(`${timestamp}.${payload}`);
  let matched = false;
  for (const signature of signatures) {
    const bytes = hexToBytes(signature);
    if (bytes && await crypto.subtle.verify('HMAC', key, bytes, signed)) {
      matched = true;
      break;
    }
  }
  if (!matched) fail('No signatures found matching the expected signature for payload.');
  if (tolerance > 0 && Math.floor(nowMs / 1000) - timestamp > tolerance) fail('Timestamp outside the tolerance zone');
}

// Parity with stripe-node's buildEvent: a v2 "thin" notification is not a webhook event.
export function parseStripeEvent(payload: string): StripeEvent {
  const event = JSON.parse(payload) as StripeEvent;
  if (event && event.object === 'v2.core.event') {
    throw new Error('Thin event notifications are not supported by this endpoint');
  }
  return event;
}

// The subset of stripe-node's resource API the provider calls, backed by the fetch client above.
// Typed structurally (not as the provider's StripeClient) so this module stays free of provider
// imports; the provider checks the fit where it assigns it.
export function createStripeFetchClient(secretKey: string, options: StripeFetchClientOptions = {}) {
  const api = createStripeApiClient(secretKey, options);
  const id = (value: string) => encodeURIComponent(value);
  return {
    checkout: { sessions: {
      create: (params: StripeCheckoutSessionCreateParams, requestOptions?: StripeRequestOptions) =>
        api.request<StripeCheckoutSession>('POST', '/v1/checkout/sessions', params, requestOptions),
      retrieve: (sessionId: string) => api.request<StripeCheckoutSession>('GET', `/v1/checkout/sessions/${id(sessionId)}`),
    } },
    refunds: {
      create: (params: StripeRefundCreateParams, requestOptions?: StripeRequestOptions) =>
        api.request<StripeRefund>('POST', '/v1/refunds', params, requestOptions),
      list: (params: StripeRefundListParams) => api.request<StripeList<StripeRefund>>('GET', '/v1/refunds', params),
    },
    paymentIntents: {
      cancel: (paymentIntentId: string) => api.request<StripePaymentIntent>('POST', `/v1/payment_intents/${id(paymentIntentId)}/cancel`),
    },
    webhooks: {
      async constructEventAsync(payload: string, signature: string, secret: string, tolerance?: number): Promise<StripeEvent> {
        await verifyStripeSignature(payload, signature, secret, tolerance || STRIPE_WEBHOOK_TOLERANCE_SECONDS);
        return parseStripeEvent(payload);
      },
    },
  };
}
