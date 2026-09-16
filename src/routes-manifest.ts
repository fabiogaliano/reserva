// Canonical route table: the integration's injectRoute calls and the shipped
// components' endpoint defaults both read from here so a route rename can't
// silently desync the widget from what's actually mounted.

import { z } from 'astro/zod';
import type { ResolvedClientConfig } from './core/config.js';
import { resolvedRoutePaths, routePatterns, type ReservaRouteId, type ReservaRoutePaths } from './core/route-paths.js';

export { routePath, resolvedRoutePaths } from './core/route-paths.js';
export type { ReservaRouteGroup, ReservaRouteId, ReservaRoutePaths } from './core/route-paths.js';

export interface ReservaRouteEntry {
  readonly id: ReservaRouteId;
  readonly group: (typeof routePatterns)[number]['group'];
  readonly pattern: string;
  readonly entrypoint: string;
}

// The Astro-only half of the table: `src/core/route-paths.ts` owns id/group/pattern (it is
// importable from a browser bundle), and this map adds the module each pattern is injected from.
const routeEntrypoints: Record<ReservaRouteId, string> = {
  availability: './routes/api/booking/availability.ts',
  checkout: './routes/api/booking/checkout.ts',
  quote: './routes/api/booking/quote.ts',
  catalog: './routes/api/booking/catalog.ts',
  webhooksPayment: './routes/api/booking/webhooks/payment.ts',
  status: './routes/api/booking/status.ts',
  manageApi: './routes/api/booking/manage.ts',
  cancel: './routes/api/booking/cancel.ts',
  reschedule: './routes/api/booking/reschedule.ts',
  operatorCancel: './routes/api/booking/operator/cancel.ts',
  operatorReschedule: './routes/api/booking/operator/reschedule.ts',
  operatorNoShow: './routes/api/booking/operator/no-show.ts',
  opsHealth: './routes/api/booking/ops/health.ts',
  reconcile: './routes/api/booking/ops/reconcile.ts',
  assetsCss: './routes/booking/assets.ts',
  assetsJs: './routes/booking/assets-js.ts',
  adminPage: './routes/booking/admin.ts',
  managePage: './routes/booking/manage.ts',
  confirmationPage: './routes/booking-confirmation.ts',
};

export const routeManifest: readonly ReservaRouteEntry[] = routePatterns.map((entry) => ({
  ...entry,
  entrypoint: routeEntrypoints[entry.id],
}));

// Feature groups a consumer can turn off via `config.routes`. `customer` and `webhook` are absent
// here: the booking API is load-bearing, never disableable. `manage` holds only the server-rendered
// /booking/manage page — cancel/reschedule APIs stay in `customer` so a headless consumer can swap the built-in page.
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

// The single object threaded through `virtual:reserva/config` (and, at request time, onto
// `ReservaContext.routeConfig`) so every URL-producing site reads the same resolved paths and the
// same group flags, instead of some seeing a prefix and others not.
export interface ReservaResolvedRouteConfig {
  paths: ReservaRoutePaths;
  groups: ReservaRouteGroupFlags;
  // True only in output built by `astro dev`. Derived from the build command, never from runtime
  // env, so a production bundle can't be talked into a development behaviour by a stray variable.
  dev: boolean;
}

export function resolveRouteConfig(
  prefix = '',
  groups: ReservaRouteGroupFlags = { admin: true, ops: true, manage: true },
  dev = false,
): ReservaResolvedRouteConfig {
  return { paths: resolvedRoutePaths(prefix), groups, dev };
}

// The whole payload of `virtual:reserva/config`: one build-time source for the validated config and
// the resolved route table, so a runtime module, a component and a handler never disagree about
// either. Serialized as JSON, which is why nothing in `ResolvedClientConfig` may be a function.
export interface ReservaVirtualConfig {
  config: ResolvedClientConfig;
  routes: ReservaResolvedRouteConfig;
}

export function requireEnabledRoutePath(routeConfig: ReservaResolvedRouteConfig, id: ReservaRouteId): string {
  const entry = routeManifest.find((candidate) => candidate.id === id);
  if (entry && !isRouteEnabled(entry, routeConfig.groups)) {
    throw new Error(`Reserva route "${id}" is disabled by routes: { ${entry.group}: false }. Enable routes.${entry.group} or provide an explicit endpoint.`);
  }
  return routeConfig.paths[id];
}

// Pure normalization only (leading slash, no trailing slash, ''/'/' => no prefix). Rejecting
// malformed input (whitespace, "..") is the caller's job via Zod — this function assumes it
// already received a value that passed that check.
export function normalizeRoutePrefix(prefix: string): string {
  if (!prefix || prefix === '/') return '';
  const withLeadingSlash = prefix.startsWith('/') ? prefix : `/${prefix}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');
  return withoutTrailingSlash === '' ? '' : withoutTrailingSlash;
}

// Mirrors `validateConfig`'s style: a Zod schema, `safeParse`, and rethrowing the raw `ZodError`
// so the caller reports it the same way it reports a bad `options.config`. Rejects whitespace/
// traversal/URL syntax before normalization can turn an unsafe value into a generated route.
const routePrefixSchema = z
  .string()
  .refine((value) => !/\s/.test(value), { message: 'routePrefix must not contain whitespace' })
  .refine((value) => !value.includes('..'), { message: 'routePrefix must not contain ".."' })
  .refine((value) => !value.includes('?'), { message: 'routePrefix must not contain a query string' })
  .refine((value) => !value.includes('#'), { message: 'routePrefix must not contain a fragment' })
  .refine((value) => !value.includes('\\'), { message: 'routePrefix must not contain backslashes' })
  .refine((value) => !value.includes(':'), { message: 'routePrefix must not contain a URL scheme' })
  .refine((value) => !value.includes('//'), { message: 'routePrefix must not contain consecutive slashes' });

// `routes` lives on ClientConfig — this schema validates only `routePrefix`, the one remaining
// Astro-only mounting-detail option.
const routeOptionsSchema = z.object({
  routePrefix: routePrefixSchema.optional(),
});

export type ReservaRouteOptions = z.infer<typeof routeOptionsSchema>;

export function validateRouteOptions(input: unknown): ReservaRouteOptions {
  const parsed = routeOptionsSchema.safeParse(input);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}
