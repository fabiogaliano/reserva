// The one shared, fail-closed admin auth gate every admin/ops handler consumes, never per-route
// wiring, so a later route in either protected group inherits it automatically.
import type { AdminIdentity } from './access.js';
import type { ReservaContext } from './context.js';

export type { AdminIdentity } from './access.js';

export async function accessAllowed(request: Request, context: ReservaContext): Promise<AdminIdentity | null> {
  if (!context.adminAuth) return null;
  try {
    return (await context.adminAuth(request, context)) ?? null;
  } catch {
    // A throwing custom adminAuth is unauthorized, not a 500 — a fail-closed contract.
    return null;
  }
}
