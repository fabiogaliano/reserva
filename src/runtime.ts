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
// Plan 025: the admin auth port's default implementation, exported so a consumer's custom
// `adminAuth` can compose with it (e.g. fall back to Access) or reference `AdminIdentity` directly.
export { cloudflareAccessAdminAuth } from './access.js';
export type { AdminIdentity } from './access.js';
// Plan 020 (design decision 1): the typed reconciliation function a consumer's own custom Worker
// entrypoint's `scheduled()` calls — `runtime.createContext` builds the ReservaContext (a
// scheduled event has no incoming Request; pass a synthetic same-origin one), then this function
// runs the bounded sweep/claim/incident/alert pass. Exported without any internal repo record type
// (ReconciliationSummary is plain counts) so a consumer never needs src/repo.ts's shapes.
export { runReconciliation, type ReconciliationOptions, type ReconciliationSummary } from './reconciliation.js';
