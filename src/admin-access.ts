// Extracted from src/handlers/index.ts (plan 009) so `AdminDashboard.astro` can run the same admin
// auth check the built-in admin route uses instead of duplicating it in two places. Plan 025
// promoted the underlying check from a Cloudflare-Access-specific boolean/claims hook to the
// generic `adminAuth` port (src/context.ts) — this is the one shared, fail-closed gate every
// admin/ops handler consumes, never per-route wiring, so a route added later in either protected
// group (e.g. plan 027's ops-health endpoint) inherits it automatically.
import type { AdminIdentity } from './access.js';
import type { ReservaContext } from './context.js';

export type { AdminIdentity } from './access.js';

export async function accessAllowed(request: Request, context: ReservaContext): Promise<AdminIdentity | null> {
  if (!context.adminAuth) return null;
  try {
    return (await context.adminAuth(request, context)) ?? null;
  } catch {
    // A throwing custom adminAuth is unauthorized, not a 500 — the same fail-closed contract the
    // old boolean-returning verifyAccess had for a throw.
    return null;
  }
}
