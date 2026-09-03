export { reserva, virtualRuntimeId, virtualConfigId, type ReservaIntegrationOptions } from './integration.js';
export { reserva as default } from './integration.js';
export { defineReservaRuntime, defineCloudflareReservaRuntime, getCache, getEnv } from './runtime-context.js';
export type {
  AdminAuth,
  ReservaContext,
  ReservaContextInput,
  ReservaProviders,
  ReservaRuntimeDefinition,
  ReservaRuntimeFactoryOptions,
  ReservaRuntimeRequest,
  CloudflareBinding,
  CloudflareReservaRuntimeOptions,
  CloudflareRuntimeBindings,
} from './runtime-context.js';
// Exported so a consumer's custom `adminAuth` can compose with it (e.g. fall back to Access) or
// reference `AdminIdentity` directly.
export { cloudflareAccessAdminAuth } from './access.js';
export type { AdminIdentity } from './access.js';
// `ClientConfig` is what a consumer writes; `ResolvedClientConfig` is what the runtime and a
// provider adapter receive once the schema's defaults have been applied.
export type { ClientConfig, ResolvedClientConfig } from './core/config.js';
// The UI copy seam lives at its own '@reservajs/astro/ui' subpath, not here: a page or component
// that only needs message helpers must not pull this barrel's build-time integration (and Astro's
// config machinery with it) into a browser/Worker bundle.
// A `config.emails.messages` override map typed against this union catches an unknown key at
// compile time instead of it being silently ignored at render time. Type-only, so it carries no
// runtime dependency on `src/email/` from this barrel.
export type { EmailCopyKey } from './email/copy.js';
// Exposed so `virtual:reserva/config`'s injected type declaration can reference the exact
// resolved-route-config shape via `reserva`'s existing "." export, without a dedicated subpath.
export type { ReservaResolvedRouteConfig, ReservaRouteGroupFlags, ReservaRouteId } from './routes-manifest.js';
