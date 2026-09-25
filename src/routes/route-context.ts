import runtime from 'virtual:reserva/runtime';
import virtualConfig from 'virtual:reserva/config';
import { withStoredSettings, type ReservaContext } from '../context.js';
import { readThemePreference } from '../ui/theme.js';
import type { ReservaRuntimeRequest } from '../runtime-context.js';

// runtime.createContext is authored by the consumer's own runtimeEntrypoint, wired up
// independently of routePrefix/routes, so it has no way to know about them. This seam overwrites
// the default routeConfig with the real per-build one, so no entrypoint can render a half-prefixed URL.
export async function createRouteContext(input: ReservaRuntimeRequest): Promise<ReservaContext> {
  const routeConfig = virtualConfig.routes;
  const context = await runtime.createContext(input);
  // The viewer's theme choice rides on the request cookie, resolved here so every page renders
  // <html data-theme> without an inline script (strict CSP).
  const viewerTheme = readThemePreference(input.request);
  return { ...(await withStoredSettings(context)), routeConfig, ...(viewerTheme ? { viewerTheme } : {}) };
}
