// Canonical route table: the integration's injectRoute calls and the shipped
// components' endpoint defaults both read from here so a route rename can't
// silently desync the widget from what's actually mounted.

export type BookkitRouteGroup = 'customer' | 'ops' | 'admin' | 'webhook';

export interface BookkitRouteEntry {
  readonly id: string;
  readonly group: BookkitRouteGroup;
  readonly pattern: string;
  readonly entrypoint: string;
}

export const routeManifest: readonly BookkitRouteEntry[] = [
  { id: 'availability', group: 'customer', pattern: '/api/booking/availability', entrypoint: './routes/api/booking/availability.ts' },
  { id: 'checkout', group: 'customer', pattern: '/api/booking/checkout', entrypoint: './routes/api/booking/checkout.ts' },
  { id: 'webhooksStripe', group: 'webhook', pattern: '/api/booking/webhooks/stripe', entrypoint: './routes/api/booking/webhooks/stripe.ts' },
  { id: 'status', group: 'customer', pattern: '/api/booking/status', entrypoint: './routes/api/booking/status.ts' },
  { id: 'manageApi', group: 'customer', pattern: '/api/booking/manage', entrypoint: './routes/api/booking/manage.ts' },
  { id: 'cancel', group: 'customer', pattern: '/api/booking/cancel', entrypoint: './routes/api/booking/cancel.ts' },
  { id: 'reschedule', group: 'customer', pattern: '/api/booking/reschedule', entrypoint: './routes/api/booking/reschedule.ts' },
  { id: 'operatorCancel', group: 'ops', pattern: '/api/booking/operator/cancel', entrypoint: './routes/api/booking/operator/cancel.ts' },
  { id: 'operatorReschedule', group: 'ops', pattern: '/api/booking/operator/reschedule', entrypoint: './routes/api/booking/operator/reschedule.ts' },
  { id: 'operatorNoShow', group: 'ops', pattern: '/api/booking/operator/no-show', entrypoint: './routes/api/booking/operator/no-show.ts' },
  { id: 'feed', group: 'ops', pattern: '/api/booking/feed', entrypoint: './routes/api/booking/feed.ts' },
  { id: 'adminPage', group: 'admin', pattern: '/booking/admin', entrypoint: './routes/booking/admin.ts' },
  { id: 'managePage', group: 'customer', pattern: '/booking/manage', entrypoint: './routes/booking/manage.ts' },
  { id: 'confirmationPage', group: 'customer', pattern: '/booking-confirmation', entrypoint: './routes/booking-confirmation.ts' },
] as const;

// Identity today; kept as the single seam a future `routePrefix` option can
// rewrite through without every caller reaching into `pattern` directly.
export function routePath(entry: BookkitRouteEntry): string {
  return entry.pattern;
}

function findRoute(id: string): BookkitRouteEntry {
  const entry = routeManifest.find((route) => route.id === id);
  if (!entry) throw new Error(`Unknown bookkit route id: ${id}`);
  return entry;
}

export const checkoutRoutePath = routePath(findRoute('checkout'));
export const availabilityRoutePath = routePath(findRoute('availability'));
