// Admin mutations are gated on Cloudflare Access (WHO), which alone is no defense against a
// cross-origin page auto-submitting a mutation using an operator's live Access session — that
// depends on the Access application cookie's SameSite setting, which this repo cannot enforce.
// Two independent layers:
//   1. adminOriginAllowed — Fetch-Metadata / Origin enforcement. Stops the attack in every modern
//      browser regardless of the cookie's SameSite value. Unconditional — never fails open.
//   2. mintAdminCsrfToken / verifyAdminCsrfToken — a signed, expiring, per-user token embedded in
//      every rendered admin form and required on every admin POST. Covers the case where
//      Sec-Fetch-Site/Origin don't survive whatever sits between the browser and this Worker.
//      Requires a real secret (RESERVA_CSRF_SECRET) to be active at all — see csrfSecret below.
// Both are wired only into the admin mutation route — never the public booking API, which is
// cross-origin-embeddable by design.

import { constantTimeEqual } from './http.js';

const CSRF_TOKEN_TTL_MS = 60 * 60_000; // Outlives a normal admin editing session; short enough to bound a leaked-token window.
export const CSRF_SECRET_ENV_NAME = 'RESERVA_CSRF_SECRET';

// Exported so tests can compute "just expired"/"still valid" boundaries without duplicating the
// constant.
export const ADMIN_CSRF_TOKEN_TTL_MS = CSRF_TOKEN_TTL_MS;

export type AdminCsrfSecretLookup = (name: string) => string | undefined | Promise<string | undefined>;

// Narrower than ReservaContext (just the two fields this module actually reads) so it stays
// independently testable and has no dependency on ./context.
export interface AdminCsrfContext {
  config: { admin: { access?: { aud: string } | undefined } };
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

// A stable derivation of whichever admin auth strategy is configured — the Access Audience tag, or
// 'custom' otherwise — so a custom-adminAuth deployment gets a distinct key from an Access
// deployment sharing the same RESERVA_CSRF_SECRET. Neither value is secret (aud is in every Access
// JWT and in checked-in config), so this is only ever mixed into the key alongside a real secret
// below, for cheap extra domain separation — never as a substitute for one. Using it alone as the
// HMAC key would make the "signed" token forgeable by anyone who knows the deployment's accessAud.
function csrfDomainSeparator(context: AdminCsrfContext): string {
  return context.config.admin.access?.aud ?? 'custom';
}

// No other genuinely-secret value is reachable here: Stripe's keys never surface on ReservaContext
// or ClientConfig, and context.secrets's optional RESERVA_OPERATOR_SECRET would cross trust domains
// for no real gain. So the only fit-for-purpose secret is RESERVA_CSRF_SECRET itself. When it isn't
// configured, there is no secret to sign with — this returns undefined and mint/verify below take
// the token layer fully offline rather than emit or accept a token that only *looks* signed. Layer 1
// (adminOriginAllowed) keeps blocking the attack on its own either way.
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

// `sub` binds the token to the admin-authorized caller it was minted for (empty string when a
// custom adminAuth has no per-user identity to bind) so a token captured from one operator's page
// cannot be replayed against a different operator's session.
//
// Returns undefined when no real secret is configured — the token layer is then inert: the form
// still renders (with no/empty token field) and relies on layer 1 alone. RESERVA_CSRF_SECRET must
// be set for layer 2 to actually run.
export async function mintAdminCsrfToken(context: AdminCsrfContext, sub: string, now: number): Promise<string | undefined> {
  const secret = await csrfSecret(context);
  if (!secret) return undefined;
  const payload: CsrfPayload = { sub, exp: now + CSRF_TOKEN_TTL_MS };
  const payloadPart = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacSign(secret, payloadPart);
  return `${payloadPart}.${signature}`;
}

// Mirrors mintAdminCsrfToken's "no secret configured" case by returning true unconditionally rather
// than false: with no secret, there is nothing a real token could prove that a forged one couldn't
// also claim, so treating a missing token as a failure would be a fake sense of security. This is a
// fail-open of layer 2 only — layer 1's origin check always runs first, so a cross-origin request is
// still rejected either way.
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

// Layer 1: Fetch-Metadata / Origin enforcement, wired only to admin mutation routes.
export function adminOriginAllowed(request: Request): boolean {
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite !== null) {
    // Sec-Fetch-Site is set by the browser itself and cannot be influenced by page script, so once
    // present it is authoritative and Origin is not consulted. `same-site` is treated as untrusted,
    // not just `cross-site`: a same-site sibling/subdomain can still host a hostile auto-submitting
    // form, and Access's session cookie is commonly scoped to the whole apex domain.
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
