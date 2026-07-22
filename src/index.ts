export { bookkit, virtualRuntimeId, virtualConfigId, type BookkitIntegrationOptions } from './integration';
export { bookkit as default } from './integration';
export { defineBookkitRuntime, defineCloudflareBookkitRuntime, getCache, getEnv } from './runtime-context';
export type {
  BookkitContext,
  BookkitContextInput,
  BookkitProviders,
  BookkitRuntimeDefinition,
  BookkitRuntimeFactoryOptions,
  BookkitRuntimeRequest,
  CloudflareBinding,
  CloudflareBookkitRuntimeOptions,
  CloudflareRuntimeBindings,
} from './runtime-context';
export type { ClientConfig } from './core/config';
// The UI copy seam: consumers type their `config.ui.messages` catalogs (and widget `messages`
// props) against these, and can read the shipped English defaults as the reference key set.
export { defaultMessages, formatMessage, resolveMessages } from './ui/messages';
export type { BookkitMessageKey, BookkitMessages } from './ui/messages';
// Exposed so `virtual:bookkit/config`'s injected type declaration (integration.ts's
// virtualConfigTypes) can reference the exact resolved-route-config shape via `bookkit`'s existing
// "." export, without adding a dedicated "./routes-manifest" subpath just for this one type.
export type { BookkitResolvedRouteConfig, BookkitRouteGroupFlags, BookkitRouteId } from './routes-manifest';
