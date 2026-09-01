export { bookkit, virtualRuntimeId, virtualConfigId, type BookkitIntegrationOptions } from './integration';
export { bookkit as default } from './integration';
export { defineBookkitRuntime, defineCloudflareBookkitRuntime, getCache, getEnv } from './runtime-context';
export type {
  AdminAuth,
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
// Plan 025: the admin auth port's default implementation, exported so a consumer's custom
// `adminAuth` can compose with it (e.g. fall back to Access) or reference `AdminIdentity` directly.
export { cloudflareAccessAdminAuth } from './access';
export type { AdminIdentity } from './access';
export type { ClientConfig } from './core/config';
// The UI copy seam: consumers type their `config.ui.messages` catalogs (and widget `messages`
// props) against these, and can read the English fallback as the reference key set.
export { defaultLocale, defaultMessages, formatMessage, resolveMessages, SLOT_STATUS_MESSAGE_KEYS } from './ui/messages';
export type { BookkitMessageKey, BookkitMessages, SlotStatusMessageKey } from './ui/messages';
// Plan 026 (design decision 2): the email copy-key union, so a `config.emails.messages` override
// map typed against it (`Partial<Record<EmailCopyKey, string>>`) catches an unknown key at compile
// time instead of it being silently ignored at render time — mirrors BookkitMessageKey above for
// widget copy. Type-only, so it carries no runtime dependency on `src/email/` from this barrel.
export type { EmailCopyKey } from './email/copy';
// Exposed so `virtual:bookkit/config`'s injected type declaration (integration.ts's
// virtualConfigTypes) can reference the exact resolved-route-config shape via `bookkit`'s existing
// "." export, without adding a dedicated "./routes-manifest" subpath just for this one type.
export type { BookkitResolvedRouteConfig, BookkitRouteGroupFlags, BookkitRouteId } from './routes-manifest';
