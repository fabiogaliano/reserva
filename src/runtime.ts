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
// The shipped operational alert sink. The runtime wires it automatically when `providers.alerts` is
// absent and the email provider implements `sendMessage`; export it so a consumer can point alerts
// at a different mailbox explicitly.
export { emailAlertSink, type EmailAlertSinkOptions } from './alerts/email-sink.js';
export { loggerAlertSink } from './alerts/logger-sink.js';
export type { AdminIdentity } from './access.js';
// The typed reconciliation function a consumer's own custom Worker entrypoint's `scheduled()`
// calls — build the ReservaContext with a synthetic same-origin Request, then this runs the bounded
// sweep/claim/incident/alert pass. Exported without any internal repo record type so a consumer never needs repo.ts's shapes.
export {
  runReconciliation,
  runReconciliationWithLease,
  scheduledHandler,
  RECONCILIATION_CADENCE_MINUTES,
  type LeasedReconciliationResult,
  type ReconciliationOptions,
  type ReconciliationSummary,
} from './reconciliation.js';
// A hand-built scheduled() context comes straight from runtime.createContext, which knows only the
// file config; this overlays the admin settings page's stored overrides, as scheduledHandler does.
export { withStoredSettings } from './context.js';
