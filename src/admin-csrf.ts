// BK-SEC-001: admin mutations (src/handlers/index.ts handleAdminPost) previously gated only on
// Cloudflare Access (WHO), with no defense against a cross-origin page auto-submitting a mutation
// using an operator's live Access session — practical exploitability there depends entirely on the
// Access application cookie's SameSite setting, which is a Cloudflare dashboard setting this repo
// cannot enforce (see README "Admin access and booking tokens" for the recommendation to set it to
// Lax/Strict). Two independent layers, belt and braces:
//   1. adminOriginAllowed — Fetch-Metadata / Origin enforcement. Stops the attack in every modern
//      browser regardless of the cookie's SameSite value. Unconditional — never fails open.
//   2. mintAdminCsrfToken / verifyAdminCsrfToken — a signed, expiring, per-user token embedded in
//      every rendered admin form and required on every admin POST. Covers the case where
//      Sec-Fetch-Site/Origin don't survive whatever sits between the browser and this Worker (that
//      Cloudflare Access preserves them unmodified is not documented as a guarantee — UNVERIFIED).
//      Requires a real secret (RESERVA_CSRF_SECRET) to be active at all — see csrfSecret below for
//      why, and for what happens when one isn't configured.
// Both are wired only into the admin mutation route — never the public booking API
// (checkout/status), which is intentionally cross-origin-embeddable (the widget can be embedded on
// a marketing site).

import { constantTimeEqual } from './http.js';

const CSRF_TOKEN_TTL_MS = 60 * 60_000; // Outlives a normal admin editing session; short enough to bound a leaked-token window.
const CSRF_SECRET_ENV_NAME = 'RESERVA_CSRF_SECRET';

// Exported so tests can compute "just expired"/"still valid" boundaries without duplicating the
// constant.
export const ADMIN_CSRF_TOKEN_TTL_MS = CSRF_TOKEN_TTL_MS;

export type AdminCsrfSecretLookup = (name: string) => string | undefined | Promise<string | undefined>;

// Deliberately narrower than ReservaContext (just the two fields this module actually reads) so it
// stays independently testable and has no dependency on ./context.
export interface AdminCsrfContext {
  config: { admin: { access?: { aud: string } } };
  secrets?: AdminCsrfSecretLookup;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

// Plan 025 (design decision 5): the domain-separation input switched from `config.admin.accessAud`
// alone to a stable derivation of whichever admin auth strategy is actually configured — the Access
// application's Audience tag when `config.admin.access` is set, or the literal 'custom' otherwise,
// so a deployment using a custom `adminAuth` still gets a distinct key from an Access deployment
// sharing the same RESERVA_CSRF_SECRET. Neither value is secret: `aud` appears in the `aud` claim of
// every Access-issued JWT and in checked-in config, and 'custom' is a fixed literal — an attacker
// does not need to compromise anything to learn either. An earlier version of this function used
// accessAud as the HMAC key on its own whenever RESERVA_CSRF_SECRET was unset, which made the
// "signed" token forgeable by anyone who knew the deployment's accessAud (i.e. effectively
// everyone), defeating layer 2 while looking like a defense. This derivation is only ever mixed into
// the key alongside a real secret below, for cheap extra domain separation — never as a substitute
// for one.
function csrfDomainSeparator(context: AdminCsrfContext): string {
  return context.config.admin.access?.aud ?? 'custom';
}

// No other genuinely-secret value is reachable here. Checked at the mint/verify call sites
// (handleAdminGet/handleAdminPost in src/handlers/index.ts, both fed by ReservaContext):
//   - Stripe's secretKey/webhookSecret are constructor options passed straight into StripeProvider
//     (src/providers/stripe.ts) — they never surface on ReservaContext or ClientConfig, so they are
//     not reachable from here without reaching into a specific payment provider's internals (which
//     would break for any non-Stripe or fake PaymentProvider).
//   - context.secrets can read RESERVA_OPERATOR_SECRET, but it's optional (unset for any deployment
//     that doesn't use the operator endpoints) and mixing an unrelated feature's secret into CSRF signing
//     crosses trust domains for no real gain (see docs/decisions.md #4).
// So the only fit-for-purpose secret is RESERVA_CSRF_SECRET itself. When it isn't configured, there
// is no secret to sign with — this returns undefined and mint/verify below take the token layer
// fully offline (see their comments) rather than emit or accept a token that only *looks* signed.
// Layer 1 (adminOriginAllowed) is unconditional and keeps blocking the attack on its own either way.
async function csrfSecret(context: AdminCsrfContext): Promise<string | undefined> {
  const configured = context.secrets ? await context.secrets(CSRF_SECRET_ENV_NAME) : undefined;
  return configured ? `${configured}:${csrfDomainSeparator(context)}` : undefined;
}

interface CsrfPayload { sub: string; exp: number }

function isCsrfPayload(value: unknown): value is CsrfPayload {
  return typeof value === 'object' && value !== null
    && typeof (value as { sub?: unknown }).sub === 'string'
    && typeof (value as { exp?: unknown }).exp === 'number';
}

// `sub` binds the token to the admin-authorized caller it was minted for (AdminIdentity.subject,
// empty string when a custom adminAuth has no per-user identity to bind — see accessAllowed in
// src/admin-access.ts) so a token captured from one operator's rendered page cannot be replayed
// against a different operator's session.
//
// Returns undefined when no real secret is configured (see csrfSecret above) — the token layer is
// then inert: handleAdminGet still renders the form (with no/empty token field, see
// src/handlers/index.ts) and relies on layer 1 (adminOriginAllowed) alone. RESERVA_CSRF_SECRET must
// be set for layer 2 to actually run.
export async function mintAdminCsrfToken(context: AdminCsrfContext, sub: string, now: number): Promise<string | undefined> {
  const secret = await csrfSecret(context);
  if (!secret) return undefined;
  const payload: CsrfPayload = { sub, exp: now + CSRF_TOKEN_TTL_MS };
  const payloadPart = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSign(secret, payloadPart);
  return `${payloadPart}.${signature}`;
}

// Mirrors mintAdminCsrfToken's "no secret configured" case by returning true unconditionally (i.e.
// not blocking on the token at all) rather than false: with no secret, there is nothing a real token
// could prove that a forged one couldn't also claim, so treating a missing/wrong token as a failure
// would be a fake sense of security, not a real one. This is a deliberate fail-open of layer 2 only
// — handleAdminPost always runs the layer 1 origin check first and unconditionally, so a cross-origin
// request is still rejected with or without a configured CSRF secret.
export async function verifyAdminCsrfToken(context: AdminCsrfContext, token: string | null | undefined, sub: string, now: number): Promise<boolean> {
  const secret = await csrfSecret(context);
  if (!secret) return true;
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payloadPart = token.slice(0, dot);
  const signaturePart = token.slice(dot + 1);
  if (!signaturePart) return false;
  const expectedSignature = await hmacSign(secret, payloadPart);
  // Constant-time compare the signature before parsing/trusting the payload at all.
  if (!constantTimeEqual(expectedSignature, signaturePart)) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart)));
  } catch {
    return false;
  }
  if (!isCsrfPayload(payload)) return false;
  if (now >= payload.exp) return false;
  return constantTimeEqual(payload.sub, sub);
}

// Layer 1 (BK-SEC-001): Fetch-Metadata / Origin enforcement, wired only to admin mutation routes.
export function adminOriginAllowed(request: Request): boolean {
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite !== null) {
    // Sec-Fetch-Site is set by the browser itself and cannot be influenced by page script, so once
    // present it is authoritative and Origin is not consulted. `same-site` is deliberately treated
    // as untrusted, not just `cross-site`: a same-site sibling/subdomain can still host a hostile
    // auto-submitting form, and Cloudflare Access's own session cookie is commonly scoped to the
    // whole apex domain — so "same site" is not this admin surface's real trust boundary.
    return secFetchSite === 'same-origin';
  }
  // No Sec-Fetch-Site (older browser, or something between the browser and this Worker stripped
  // it). Fall back to Origin; a POST with neither header present cannot be proven same-origin and
  // is rejected by the `origin === null` case below.
  const origin = request.headers.get('origin');
  if (origin === null) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
