import runtime from 'virtual:reserva/runtime';
import routeConfig from 'virtual:reserva/config';
import type { ReservaContext } from '../context.js';
import { loadMergedConfig } from '../core/settings.js';
import { readThemePreference } from '../ui/theme.js';
import type { ReservaRuntimeRequest } from '../runtime-context.js';

// runtime.createContext is authored by the consumer's own runtimeEntrypoint, wired up
// independently of routePrefix/routes, so it has no way to know about them. This seam overwrites
// the default routeConfig with the real per-build one, so no entrypoint can render a half-prefixed URL.
export async function createRouteContext(input: ReservaRuntimeRequest): Promise<ReservaContext> {
  const context = await runtime.createContext(input);
  // The viewer's theme choice rides on the request cookie, resolved here so every page renders
  // <html data-theme> without an inline script (strict CSP).
  const viewerTheme = readThemePreference(input.request);
  // Operator-edited settings (the admin settings page) are merged here, in the one seam every
  // route entrypoint passes through, so handlers never distinguish file config from overrides.
  // `baseConfig` keeps the pristine file values for the settings page's "config default" hints.
  const overrides = await context.repo.listSettings();
  if (Object.keys(overrides).length === 0) return { ...context, routeConfig, viewerTheme };
  // A row saved before a bound tightened must degrade to the file config for this request, not
  // serve an invalid config or take down the whole site — loadMergedConfig drops offending rows
  // and reports them here so they show up in logs instead of silently persisting.
  const merged = loadMergedConfig(context.config, overrides, (warning) => {
    context.logger.warn?.('reserva.settings.invalid_override', { key: warning.key, reason: warning.reason });
  });
  return { ...context, routeConfig, viewerTheme, baseConfig: context.config, config: merged };
}
