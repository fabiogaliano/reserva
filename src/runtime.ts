export {
  defineBookkitRuntime,
  defineCloudflareBookkitRuntime,
  getCache,
  getEnv,
  type AdminAuth,
  type BookkitContext,
  type BookkitContextInput,
  type BookkitEnvShape,
  type BookkitProviders,
  type BookkitRuntime,
  type BookkitRuntimeDefinition,
  type BookkitRuntimeFactoryOptions,
  type BookkitRuntimeRequest,
  type CloudflareBinding,
  type CloudflareBookkitRuntimeOptions,
  type CloudflareRuntimeBindings,
} from './runtime-context';
// Plan 025: the admin auth port's default implementation, exported so a consumer's custom
// `adminAuth` can compose with it (e.g. fall back to Access) or reference `AdminIdentity` directly.
export { cloudflareAccessAdminAuth } from './access';
export type { AdminIdentity } from './access';
// Plan 020 (design decision 1): the typed reconciliation function a consumer's own custom Worker
// entrypoint's `scheduled()` calls — `runtime.createContext` builds the BookkitContext (a
// scheduled event has no incoming Request; pass a synthetic same-origin one), then this function
// runs the bounded sweep/claim/incident/alert pass. Exported without any internal repo record type
// (ReconciliationSummary is plain counts) so a consumer never needs src/repo.ts's shapes.
export { runReconciliation, type ReconciliationOptions, type ReconciliationSummary } from './reconciliation';
