import runtime from 'virtual:bookkit/runtime';
import routeConfig from 'virtual:bookkit/config';
import type { BookkitContext } from '../context';
import { applySettingOverrides } from '../core/settings';
import { readThemePreference } from '../ui/theme';
import type { BookkitRuntimeRequest } from '../runtime-context';

// Every route entrypoint must see the SAME resolved (prefixed) route table + group flags the
// integration injected it under. `runtime.createContext` is authored by the consumer's own
// runtimeEntrypoint, wired up independently of `routePrefix`/`routes` (see runtime-context.ts), so
// it has no way to know about them — this seam overwrites the context's default (unprefixed)
// routeConfig with the real per-build one right after creation, uniformly, so no entrypoint file
// can forget it and end up rendering a half-prefixed URL.
export async function createRouteContext(input: BookkitRuntimeRequest): Promise<BookkitContext> {
  const context = await runtime.createContext(input);
  // The viewer's theme choice rides on the request cookie, resolved here so every page renders
  // <html data-theme> without an inline script (strict CSP).
  const viewerTheme = readThemePreference(input.request);
  // Operator-edited settings (the admin settings page) are merged here, in the one seam every
  // route entrypoint passes through, so handlers never distinguish file config from overrides.
  // `baseConfig` keeps the pristine file values for the settings page's "config default" hints.
  const overrides = await context.repo.listSettings();
  if (Object.keys(overrides).length === 0) return { ...context, routeConfig, viewerTheme };
  return { ...context, routeConfig, viewerTheme, baseConfig: context.config, config: applySettingOverrides(context.config, overrides) };
}
