export {
  defineReservaRuntime,
  defineCloudflareReservaRuntime,
  getCache,
  getEnv,
  type AdminAuth,
  type ReservaContext,
  type ReservaContextInput,
  type ReservaEnvShape,
  type ReservaProviders,
  type ReservaRuntime,
  type ReservaRuntimeDefinition,
  type ReservaRuntimeFactoryOptions,
  type ReservaRuntimeRequest,
  type CloudflareBinding,
  type CloudflareReservaRuntimeOptions,
  type CloudflareRuntimeBindings,
} from './runtime-context.js';
// The admin auth port's default implementation, exported so a consumer's custom
// `adminAuth` can compose with it (e.g. fall back to Access) or reference `AdminIdentity` directly.
export { cloudflareAccessAdminAuth } from './access.js';
export type { AdminIdentity } from './access.js';
// The typed reconciliation function a consumer's own custom Worker entrypoint's `scheduled()`
// calls — build the ReservaContext with a synthetic same-origin Request, then this runs the bounded
// sweep/claim/incident/alert pass. Exported without any internal repo record type so a consumer never needs repo.ts's shapes.
export { runReconciliation, scheduledHandler, type ReconciliationOptions, type ReconciliationSummary } from './reconciliation.js';
