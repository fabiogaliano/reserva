// Canonical route table: the integration's injectRoute calls and the shipped
// components' endpoint defaults both read from here so a route rename can't
// silently desync the widget from what's actually mounted.

import { z } from 'astro/zod';

export type BookkitRouteGroup = 'customer' | 'ops' | 'admin' | 'webhook';

export interface BookkitRouteEntry {
  readonly id: string;
  readonly group: BookkitRouteGroup;
  readonly pattern: string;
  readonly entrypoint: string;
}

// `satisfies` (not a `readonly BookkitRouteEntry[]` annotation) so the literal `id`/`group` values
// survive into `typeof routeManifest` — an explicit interface-typed annotation would widen `id` to
// `string`, which under `noUncheckedIndexedAccess` turns every `Record<BookkitRouteId, string>`
// property read (e.g. `routeConfig.paths.checkout`) into `string | undefined` throughout the
// codebase, forcing every call site to re-null-check a value that can never actually be missing.
export const routeManifest = [
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
] as const satisfies readonly BookkitRouteEntry[];

export type BookkitRouteId = (typeof routeManifest)[number]['id'];

// Feature groups a consumer can turn off via `bookkit({ routes: { admin, ops } })`. `customer`
// and `webhook` are absent here on purpose: the booking API and customer pages are load-bearing,
// so they are never disableable (see integration.ts's BookkitIntegrationOptions).
export interface BookkitRouteGroupFlags {
  admin: boolean;
  ops: boolean;
}

export function isRouteEnabled(entry: BookkitRouteEntry, groups: BookkitRouteGroupFlags): boolean {
  if (entry.group === 'admin') return groups.admin;
  if (entry.group === 'ops') return groups.ops;
  return true;
}

export function enabledRouteManifest(groups: BookkitRouteGroupFlags): readonly BookkitRouteEntry[] {
  return routeManifest.filter((entry) => isRouteEnabled(entry, groups));
}

// The seam a `routePrefix` option rewrites through: `prefix` must already be normalized (see
// normalizeRoutePrefix below) so every call site produces a consistently-prefixed pattern instead
// of half-prefixed strings assembled ad hoc at each URL-producing site.
export function routePath(entry: BookkitRouteEntry, prefix = ''): string {
  return prefix + entry.pattern;
}

// The full { routeId -> resolved pattern } table exposed through `virtual:bookkit/config` so
// components and handlers read their URL defaults from one resolved source instead of each
// re-deriving `prefix + pattern` themselves.
export function resolvedRoutePaths(prefix = ''): Record<BookkitRouteId, string> {
  return Object.fromEntries(
    routeManifest.map((entry) => [entry.id, routePath(entry, prefix)]),
  ) as Record<BookkitRouteId, string>;
}

// The single object threaded through `virtual:bookkit/config` (and, at request time, onto
// `BookkitContext.routeConfig` — see context.ts) so every URL-producing site (components, the
// server-rendered manage/admin HTML, route redirects) reads the same resolved paths *and* the
// same group flags, instead of some sites seeing a prefix and others not.
export interface BookkitResolvedRouteConfig {
  paths: Record<BookkitRouteId, string>;
  groups: BookkitRouteGroupFlags;
}

export function resolveRouteConfig(prefix = '', groups: BookkitRouteGroupFlags = { admin: true, ops: true }): BookkitResolvedRouteConfig {
  return { paths: resolvedRoutePaths(prefix), groups };
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
// `options.config`. Deliberately narrow — only rejects the "obviously broken" values the handoff
// names (whitespace, ".." traversal segments); everything else is left to `normalizeRoutePrefix`.
const routePrefixSchema = z
  .string()
  .refine((value) => !/\s/.test(value), { message: 'routePrefix must not contain whitespace' })
  .refine((value) => !value.includes('..'), { message: 'routePrefix must not contain ".."' })
  .refine((value) => !value.includes('?'), { message: 'routePrefix must not contain a query string' })
  .refine((value) => !value.includes('#'), { message: 'routePrefix must not contain a fragment' })
  .refine((value) => !value.includes('\\'), { message: 'routePrefix must not contain backslashes' })
  .refine((value) => !value.includes(':'), { message: 'routePrefix must not contain a URL scheme' })
  .refine((value) => !value.includes('//'), { message: 'routePrefix must not contain consecutive slashes' });

const routeGroupFlagsInputSchema = z.object({
  admin: z.boolean().optional(),
  ops: z.boolean().optional(),
});

const routeOptionsSchema = z.object({
  routePrefix: routePrefixSchema.optional(),
  routes: routeGroupFlagsInputSchema.optional(),
});

export type BookkitRouteOptions = z.infer<typeof routeOptionsSchema>;

export function validateRouteOptions(input: unknown): BookkitRouteOptions {
  const parsed = routeOptionsSchema.safeParse(input);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}
