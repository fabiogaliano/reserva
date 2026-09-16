// The one shared, fail-closed admin auth gate every admin/ops handler consumes, never per-route
// wiring, so a later route in either protected group inherits it automatically.
import type { AdminIdentity } from './access.js';
import type { ReservaContext } from './context.js';

export type { AdminIdentity } from './access.js';

// Cloudflare Access cannot issue an assertion for localhost, so `astro dev` output would otherwise
// be permanently locked out of its own dashboard and every consumer would ship a hand-written
// bypass. `routeConfig.dev` comes from Astro's build command, never from runtime env, so a
// production bundle cannot be talked into this by a stray variable.
const DEV_IDENTITY: AdminIdentity = { subject: 'dev' };

// A custom `adminAuth` is never bypassed: its author owns what it lets through, and the runtime
// already guarantees exactly one of the two paths is configured, so `admin.access` being set means
// the gate below is the shipped Access implementation.
export function adminDevBypassActive(context: ReservaContext): boolean {
  return context.routeConfig.dev && Boolean(context.config.admin.access);
}

let bypassWarned = false;

export async function accessAllowed(request: Request, context: ReservaContext): Promise<AdminIdentity | null> {
  if (adminDevBypassActive(context)) {
    // Once per isolate: the dashboard issues many requests per page and an operator only needs to
    // be told what they are looking at once.
    if (!bypassWarned) {
      bypassWarned = true;
      context.logger.warn?.('admin auth bypassed: astro dev');
    }
    return DEV_IDENTITY;
  }
  if (!context.adminAuth) return null;
  try {
    return (await context.adminAuth(request, context)) ?? null;
  } catch {
    // A throwing custom adminAuth is unauthorized, not a 500 — a fail-closed contract.
    return null;
  }
}
