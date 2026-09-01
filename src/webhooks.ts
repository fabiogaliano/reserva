// Plan 021 (design decision 3): outbound webhook delivery. Deliberately an internal module rather
// than a provider subpath — a webhook endpoint is declared in `ClientConfig.webhooks`, not wired as
// a provider, so there is nothing for a consumer to construct or import here.
//
// Signing follows the Standard Webhooks spec (https://www.standardwebhooks.com): the receiver
// verifies with any off-the-shelf implementation of that spec instead of a recipe documented only
// here. Implemented on WebCrypto so the library keeps zero runtime dependencies for it; the spec's
// own library is used in the tests as the independent verifier.
import { ProviderFailure } from './provider-failure';

// Brand visibility rides the User-Agent, never a second signature header — the spec's three
// webhook-* headers stay the only signing surface (one truth per fact).
export const WEBHOOK_USER_AGENT = 'Reserva-Webhooks/1';

// Standard Webhooks symmetric keys are conventionally prefixed; the bytes are the base64 body.
const WEBHOOK_SECRET_PREFIX = 'whsec_';
const SIGNATURE_SCHEME = 'v1';
const MAX_ERROR_BODY_CHARS = 200;

// Mirrors BrevoResponseError/the retired Tourflow error class: a bounded body in the message and a
// structured `status`, so plan 016's classification decides retryable vs. permanent.
export class WebhookResponseError extends ProviderFailure {
  constructor(name: string, status: number, body: string) {
    super({ status, message: `Webhook "${name}" request failed (${status}): ${body.slice(0, MAX_ERROR_BODY_CHARS)}` });
    this.name = 'WebhookResponseError';
  }
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function encodeBase64(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function signingKeyBytes(name: string, secret: string): Uint8Array {
  const material = secret.startsWith(WEBHOOK_SECRET_PREFIX) ? secret.slice(WEBHOOK_SECRET_PREFIX.length) : secret;
  try {
    return decodeBase64(material);
  } catch {
    // A malformed key can never start working — abandon rather than retry, and say what to fix.
    throw new ProviderFailure({
      retryable: false,
      message: `Webhook "${name}" secret is not a Standard Webhooks key: expected base64 bytes, optionally prefixed with "${WEBHOOK_SECRET_PREFIX}".`,
    });
  }
}

// `webhook-signature` value for one attempt: base64 HMAC-SHA256 over "<id>.<timestamp>.<body>",
// space-separated `<scheme>,<signature>` pairs (a single pair here — we never key-rotate mid-send).
export async function signWebhookPayload(input: {
  name: string;
  secret: string;
  id: string;
  timestamp: string;
  body: string;
}): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    signingKeyBytes(input.name, input.secret) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${input.id}.${input.timestamp}.${input.body}`));
  return `${SIGNATURE_SCHEME},${encodeBase64(signed)}`;
}

export interface WebhookDelivery {
  name: string;
  url: string;
  secret: string;
  // The envelope id — also the `webhook-id` header, so a receiver deduplicates on the same value
  // the envelope carries.
  id: string;
  // The already-serialized envelope. Sent byte-for-byte: retries re-sign the stored bytes rather
  // than re-projecting the booking, which is what keeps a retry's payload identical to attempt one.
  body: string;
  now: Date;
  fetchImpl?: typeof fetch;
}

export async function deliverWebhook(delivery: WebhookDelivery): Promise<void> {
  // Fresh per attempt: the spec's receivers reject a timestamp outside a 300-second tolerance, so a
  // retry hours later must not replay the original occurrence's timestamp.
  const timestamp = Math.floor(delivery.now.getTime() / 1000).toString();
  const signature = await signWebhookPayload({ ...delivery, timestamp });
  const request = delivery.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const response = await request(delivery.url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': WEBHOOK_USER_AGENT,
      'webhook-id': delivery.id,
      'webhook-timestamp': timestamp,
      'webhook-signature': signature,
    },
    body: delivery.body,
  });
  if (!response.ok) throw new WebhookResponseError(delivery.name, response.status, await response.text());
}
