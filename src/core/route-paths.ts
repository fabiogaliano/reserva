// The route pattern table, split out of `routes-manifest.ts` so a browser bundle can import it:
// this module has no Astro (or any other) import, while the manifest needs Zod from `astro/zod`
// and carries the `entrypoint` paths only an Astro build can use.

export type ReservaRouteGroup = 'customer' | 'ops' | 'admin' | 'webhook' | 'manage';

export interface ReservaRoutePattern {
  readonly id: string;
  readonly group: ReservaRouteGroup;
  readonly pattern: string;
}

// `satisfies` (not a `readonly ReservaRoutePattern[]` annotation) so the literal `id`/`group` values
// survive into `typeof routePatterns` — an interface-typed annotation would widen `id` to `string`,
// turning every `Record<ReservaRouteId, string>` read into `string | undefined` under noUncheckedIndexedAccess.
export const routePatterns = [
  { id: 'availability', group: 'customer', pattern: '/api/booking/availability' },
  { id: 'checkout', group: 'customer', pattern: '/api/booking/checkout' },
  { id: 'quote', group: 'customer', pattern: '/api/booking/quote' },
  { id: 'catalog', group: 'customer', pattern: '/api/booking/catalog' },
  { id: 'webhooksPayment', group: 'webhook', pattern: '/api/booking/webhooks/payment' },
  { id: 'status', group: 'customer', pattern: '/api/booking/status' },
  { id: 'manageApi', group: 'customer', pattern: '/api/booking/manage' },
  { id: 'cancel', group: 'customer', pattern: '/api/booking/cancel' },
  { id: 'reschedule', group: 'customer', pattern: '/api/booking/reschedule' },
  { id: 'operatorCancel', group: 'ops', pattern: '/api/booking/operator/cancel' },
  { id: 'operatorReschedule', group: 'ops', pattern: '/api/booking/operator/reschedule' },
  { id: 'operatorNoShow', group: 'ops', pattern: '/api/booking/operator/no-show' },
  { id: 'opsHealth', group: 'ops', pattern: '/api/booking/ops/health' },
  { id: 'reconcile', group: 'ops', pattern: '/api/booking/ops/reconcile' },
  { id: 'assetsCss', group: 'customer', pattern: '/booking/assets/reserva.css' },
  { id: 'assetsJs', group: 'customer', pattern: '/booking/assets/reserva.js' },
  { id: 'adminPage', group: 'admin', pattern: '/booking/admin' },
  { id: 'managePage', group: 'manage', pattern: '/booking/manage' },
  { id: 'confirmationPage', group: 'customer', pattern: '/booking-confirmation' },
] as const satisfies readonly ReservaRoutePattern[];

export type ReservaRouteId = (typeof routePatterns)[number]['id'];

export type ReservaRoutePaths = Record<ReservaRouteId, string>;

// The seam a `routePrefix` option rewrites through: `prefix` must already be normalized so every
// call site produces a consistently-prefixed pattern instead of assembling one ad hoc.
export function routePath(entry: Pick<ReservaRoutePattern, 'pattern'>, prefix = ''): string {
  return prefix + entry.pattern;
}

// The full { routeId -> resolved pattern } table exposed through `virtual:reserva/config` so
// components, handlers and the browser client read their URL defaults from one resolved source
// instead of each re-deriving `prefix + pattern` themselves.
export function resolvedRoutePaths(prefix = ''): ReservaRoutePaths {
  return Object.fromEntries(
    routePatterns.map((entry) => [entry.id, routePath(entry, prefix)]),
  ) as ReservaRoutePaths;
}
