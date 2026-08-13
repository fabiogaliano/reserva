// Extracted from src/handlers/index.ts (plan 009) so `AdminDashboard.astro` can run the same
// Cloudflare Access check the built-in admin route uses instead of duplicating the
// boolean/claims subject-normalization logic in two places.
import type { BookkitContext } from './context';

export interface AdminAccess {
  // The Access-authenticated subject the admin CSRF token binds to ('' when the verifier reports a
  // plain boolean rather than claims — see the BookkitContext.verifyAccess doc comment).
  sub: string;
}

export async function accessAllowed(request: Request, context: BookkitContext): Promise<AdminAccess | null> {
  if (!context.verifyAccess) return null;
  try {
    const result = await context.verifyAccess(request);
    if (!result) return null;
    // A caller-supplied verifyAccess is only contractually required to return boolean (see
    // BookkitContext.verifyAccess) — there's no claim in a `true` to bind a per-user token to, so
    // this falls back to the empty subject. The resulting CSRF token is session-agnostic (any
    // Access-authorized caller's token verifies for any other), not a weaker token: it's still
    // unforgeable (HMAC'd with the real BOOKKIT_CSRF_SECRET, see src/admin-csrf.ts) and still
    // requires layer 1's same-origin check to ever reach the app. Only the default JWT-based
    // verifyAccessJwt path (src/runtime-context.ts) exposes real claims and gets a user-bound token.
    if (typeof result === 'boolean') return { sub: '' };
    const email = typeof result.email === 'string' ? result.email : undefined;
    const sub = typeof result.sub === 'string' ? result.sub : undefined;
    return { sub: email ?? sub ?? '' };
  } catch {
    return null;
  }
}
