// Canonical route table: the integration's injectRoute calls and the shipped
// components' endpoint defaults both read from here so a route rename can't
// silently desync the widget from what's actually mounted.

import { z } from 'astro/zod';

export type ReservaRouteGroup = 'customer' | 'ops' | 'admin' | 'webhook' | 'manage';

export interface ReservaRouteEntry {
  readonly id: string;
  readonly group: ReservaRouteGroup;
  readonly pattern: string;
  readonly entrypoint: string;
}

// `satisfies` (not a `readonly ReservaRouteEntry[]` annotation) so the literal `id`/`group` values
// survive into `typeof routeManifest` — an explicit interface-typed annotation would widen `id` to
// `string`, which under `noUncheckedIndexedAccess` turns every `Record<ReservaRouteId, string>`
// property read (e.g. `routeConfig.paths.checkout`) into `string | undefined` throughout the
// codebase, forcing every call site to re-null-check a value that can never actually be missing.
export const routeManifest = [
  { id: 'availability', group: 'customer', pattern: '/api/booking/availability', entrypoint: './routes/api/booking/availability.ts' },
  { id: 'checkout', group: 'customer', pattern: '/api/booking/checkout', entrypoint: './routes/api/booking/checkout.ts' },
  { id: 'quote', group: 'customer', pattern: '/api/booking/quote', entrypoint: './routes/api/booking/quote.ts' },
  { id: 'catalog', group: 'customer', pattern: '/api/booking/catalog', entrypoint: './routes/api/booking/catalog.ts' },
  { id: 'webhooksPayment', group: 'webhook', pattern: '/api/booking/webhooks/payment', entrypoint: './routes/api/booking/webhooks/payment.ts' },
  { id: 'status', group: 'customer', pattern: '/api/booking/status', entrypoint: './routes/api/booking/status.ts' },
  { id: 'manageApi', group: 'customer', pattern: '/api/booking/manage', entrypoint: './routes/api/booking/manage.ts' },
  { id: 'cancel', group: 'customer', pattern: '/api/booking/cancel', entrypoint: './routes/api/booking/cancel.ts' },
  { id: 'reschedule', group: 'customer', pattern: '/api/booking/reschedule', entrypoint: './routes/api/booking/reschedule.ts' },
  { id: 'operatorCancel', group: 'ops', pattern: '/api/booking/operator/cancel', entrypoint: './routes/api/booking/operator/cancel.ts' },
  { id: 'operatorReschedule', group: 'ops', pattern: '/api/booking/operator/reschedule', entrypoint: './routes/api/booking/operator/reschedule.ts' },
  { id: 'operatorNoShow', group: 'ops', pattern: '/api/booking/operator/no-show', entrypoint: './routes/api/booking/operator/no-show.ts' },
  { id: 'opsHealth', group: 'ops', pattern: '/api/booking/ops/health', entrypoint: './routes/api/booking/ops/health.ts' },
  { id: 'assetsCss', group: 'customer', pattern: '/booking/assets/reserva.css', entrypoint: './routes/booking/assets.ts' },
  { id: 'assetsJs', group: 'customer', pattern: '/booking/assets/reserva.js', entrypoint: './routes/booking/assets-js.ts' },
  { id: 'adminPage', group: 'admin', pattern: '/booking/admin', entrypoint: './routes/booking/admin.ts' },
  { id: 'managePage', group: 'manage', pattern: '/booking/manage', entrypoint: './routes/booking/manage.ts' },
  { id: 'confirmationPage', group: 'customer', pattern: '/booking-confirmation', entrypoint: './routes/booking-confirmation.ts' },
] as const satisfies readonly ReservaRouteEntry[];

export type ReservaRouteId = (typeof routeManifest)[number]['id'];

// Feature groups a consumer can turn off via `config.routes: { admin, ops, manage }` (plan 025 —
// moved here from the Astro-only ReservaIntegrationOptions.routes, since admin-auth selection needs
// the same declared intent). `customer` and `webhook` are absent here on purpose: the booking API
// is load-bearing, so it is never disableable.
//
// Plan 027 (design decision 8): `manage` holds exactly ONE entry — Reserva's server-rendered
// /booking/manage page. The manage, cancel and reschedule APIs stay in `customer` precisely so a
// headless consumer can switch the built-in page off and build its own UI on the same endpoints.
export interface ReservaRouteGroupFlags {
  admin: boolean;
  ops: boolean;
  manage: boolean;
}

export function isRouteEnabled(entry: ReservaRouteEntry, groups: ReservaRouteGroupFlags): boolean {
  if (entry.group === 'admin') return groups.admin;
  if (entry.group === 'ops') return groups.ops;
  if (entry.group === 'manage') return groups.manage;
  return true;
}

export function enabledRouteManifest(groups: ReservaRouteGroupFlags): readonly ReservaRouteEntry[] {
  return routeManifest.filter((entry) => isRouteEnabled(entry, groups));
}

// The seam a `routePrefix` option rewrites through: `prefix` must already be normalized (see
// normalizeRoutePrefix below) so every call site produces a consistently-prefixed pattern instead
// of half-prefixed strings assembled ad hoc at each URL-producing site.
export function routePath(entry: ReservaRouteEntry, prefix = ''): string {
  return prefix + entry.pattern;
}

// The full { routeId -> resolved pattern } table exposed through `virtual:reserva/config` so
// components and handlers read their URL defaults from one resolved source instead of each
// re-deriving `prefix + pattern` themselves.
export function resolvedRoutePaths(prefix = ''): Record<ReservaRouteId, string> {
  return Object.fromEntries(
    routeManifest.map((entry) => [entry.id, routePath(entry, prefix)]),
  ) as Record<ReservaRouteId, string>;
}

// The single object threaded through `virtual:reserva/config` (and, at request time, onto
// `ReservaContext.routeConfig` — see context.ts) so every URL-producing site (components, the
// server-rendered manage/admin HTML, route redirects) reads the same resolved paths *and* the
// same group flags, instead of some sites seeing a prefix and others not.
export interface ReservaResolvedRouteConfig {
  paths: Record<ReservaRouteId, string>;
  groups: ReservaRouteGroupFlags;
}

export function resolveRouteConfig(prefix = '', groups: ReservaRouteGroupFlags = { admin: true, ops: true, manage: true }): ReservaResolvedRouteConfig {
  return { paths: resolvedRoutePaths(prefix), groups };
}

export function requireEnabledRoutePath(routeConfig: ReservaResolvedRouteConfig, id: ReservaRouteId): string {
  const entry = routeManifest.find((candidate) => candidate.id === id);
  if (entry && !isRouteEnabled(entry, routeConfig.groups)) {
    throw new Error(`Reserva route "${id}" is disabled by routes: { ${entry.group}: false }. Enable routes.${entry.group} or provide an explicit endpoint.`);
  }
  return routeConfig.paths[id];
}

// Pure normalization only (leading slash, no trailing slash, ''/'/' => no prefix). Rejecting
// malformed input (whitespace, "..") is integration.ts's job via Zod, mirroring how
// `validateConfig` validates `options.config` — this function assumes it already received a
// value that passed that check.
export function normalizeRoutePrefix(prefix: string): string {
  if (!prefix || prefix === '/') return '';
  const withLeadingSlash = prefix.startsWith('/') ? prefix : `/${prefix}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');
  return withoutTrailingSlash === '' ? '' : withoutTrailingSlash;
}

// Mirrors `validateConfig`'s style (core/config.ts): a Zod schema, `safeParse`, and rethrowing the
// raw `ZodError` on failure so integration.ts can report it the same way it reports a bad
// `options.config`. It rejects whitespace/traversal plus URL and network-path syntax before
// normalization can turn an unsafe value into a generated route.
const routePrefixSchema = z
  .string()
  .refine((value) => !/\s/.test(value), { message: 'routePrefix must not contain whitespace' })
  .refine((value) => !value.includes('..'), { message: 'routePrefix must not contain ".."' })
  .refine((value) => !value.includes('?'), { message: 'routePrefix must not contain a query string' })
  .refine((value) => !value.includes('#'), { message: 'routePrefix must not contain a fragment' })
  .refine((value) => !value.includes('\\'), { message: 'routePrefix must not contain backslashes' })
  .refine((value) => !value.includes(':'), { message: 'routePrefix must not contain a URL scheme' })
  .refine((value) => !value.includes('//'), { message: 'routePrefix must not contain consecutive slashes' });

// Plan 025 (design decision 3): `routes` moved to ClientConfig (core/config.ts) — this schema now
// validates only `routePrefix`, the one remaining Astro-only mounting-detail option.
const routeOptionsSchema = z.object({
  routePrefix: routePrefixSchema.optional(),
});

export type ReservaRouteOptions = z.infer<typeof routeOptionsSchema>;

export function validateRouteOptions(input: unknown): ReservaRouteOptions {
  const parsed = routeOptionsSchema.safeParse(input);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}
