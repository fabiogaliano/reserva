import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { AstroIntegration } from 'astro';
import { envField } from 'astro/config';
import type { Plugin } from 'vite';
import { validateConfig, type ClientConfig, type ResolvedClientConfig } from './core/config.js';
import {
  enabledRouteManifest,
  normalizeRoutePrefix,
  resolveRouteConfig,
  routePath,
  validateRouteOptions,
  type ReservaResolvedRouteConfig,
  type ReservaRouteGroupFlags,
} from './routes-manifest.js';

export interface ReservaIntegrationOptions {
  config: ClientConfig | unknown;
  runtimeEntrypoint: string | URL;
  // Set to `false` to skip contributing reserva's secret names to the `astro:env` schema, e.g. if
  // the consumer already declares its own schema for these names. Defaults to on.
  envSchema?: boolean;
  // Prepended to every injected route pattern and every URL reserva renders. Normalized (leading
  // slash, no trailing) and validated; an Astro-only mounting option — route group flags live in `config.routes`.
  routePrefix?: string;
}

// Canonical secret names for reserva's optional providers. All optional: every provider is opt-in,
// so a consumer wiring up only Stripe must not fail env validation over a missing Brevo/Google key.
// This only declares the names for typed access and build-time visibility; it doesn't change how providers read them.
const reservaSecretEnvSchema = {
  STRIPE_SECRET_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
  STRIPE_WEBHOOK_SECRET: envField.string({ context: 'server', access: 'secret', optional: true }),
  BREVO_API_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
  RESERVA_OPERATOR_SECRET: envField.string({ context: 'server', access: 'secret', optional: true }),
  GOOGLE_SA_EMAIL: envField.string({ context: 'server', access: 'secret', optional: true }),
  GOOGLE_SA_PRIVATE_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
  GOOGLE_IMPERSONATE_EMAIL: envField.string({ context: 'server', access: 'secret', optional: true }),
};

const virtualRuntimeId = 'virtual:reserva/runtime';
const resolvedVirtualRuntimeId = '\0' + virtualRuntimeId;

// Static declaration (no codegen needed): the virtual module always re-exports whatever the
// consumer's runtimeEntrypoint default-exports, which is a ReservaRuntimeDefinition (aliased
// as ReservaRuntime) regardless of which entrypoint file is wired up.
const virtualRuntimeTypes = `declare module '${virtualRuntimeId}' {
  import type { ReservaRuntime } from '@reservajs/astro/runtime';
  const runtime: ReservaRuntime;
  export default runtime;
}
`;

const virtualConfigId = 'virtual:reserva/config';
const resolvedVirtualConfigId = '\0' + virtualConfigId;

// Static declaration, like virtualRuntimeTypes above: the shape is fixed (resolved paths + group
// flags), only the values differ per-consumer, so this never needs to be regenerated per-build.
const virtualConfigTypes = `declare module '${virtualConfigId}' {
  import type { ReservaResolvedRouteConfig } from '@reservajs/astro';
  const config: ReservaResolvedRouteConfig;
  export default config;
}
`;

function runtimePath(root: URL, entrypoint: string | URL): string {
  if (entrypoint instanceof URL) return fileURLToPath(entrypoint);
  if (entrypoint.startsWith('file://')) return fileURLToPath(new URL(entrypoint));
  return resolve(fileURLToPath(root), entrypoint);
}

function runtimeVirtualPlugin(entrypoint: string): Plugin {
  return {
    name: 'reserva-runtime-entrypoint',
    enforce: 'pre',
    resolveId(id) {
      return id === virtualRuntimeId ? resolvedVirtualRuntimeId : undefined;
    },
    load(id) {
      if (id !== resolvedVirtualRuntimeId) return undefined;
      return `export { default } from ${JSON.stringify(entrypoint)};`;
    },
  };
}

// The manifest names TypeScript sources, but the published package ships their compiled siblings
// beside this file in dist/ — the consumer's Astro build compiles whichever one is injected, so
// resolution simply follows the file that exists next to the integration actually running.
function routeEntrypoint(relativePath: string): string {
  const compiled = new URL(relativePath.replace(/\.ts$/, '.js'), import.meta.url);
  return existsSync(fileURLToPath(compiled)) ? fileURLToPath(compiled) : fileURLToPath(new URL(relativePath, import.meta.url));
}

// Resolved once per build/dev-server start from the (validated, normalized) prefix + group flags —
// unlike virtual:reserva/runtime, this has no dependency on the consumer's runtimeEntrypoint, so it
// can be serialized directly instead of re-exporting a file path.
function routeConfigVirtualPlugin(resolvedRouteConfig: ReservaResolvedRouteConfig): Plugin {
  return {
    name: 'reserva-route-config',
    enforce: 'pre',
    resolveId(id) {
      return id === virtualConfigId ? resolvedVirtualConfigId : undefined;
    },
    load(id) {
      if (id !== resolvedVirtualConfigId) return undefined;
      return `export default ${JSON.stringify(resolvedRouteConfig)};`;
    },
  };
}

export function reserva(options: ReservaIntegrationOptions): AstroIntegration {
  return {
    name: 'reserva',
    hooks: {
      'astro:config:setup': ({ config, injectRoute, logger, updateConfig }) => {
        // This hook runs during build/dev config resolution, separate from request-time Worker
        // execution — defineReservaRuntime/defineCloudflareReservaRuntime independently validate the
        // config that actually backs runtime behavior. The value captured here only decides which route groups to inject.
        let validatedConfig: ResolvedClientConfig;
        try {
          validatedConfig = validateConfig(options.config);
        } catch (error) {
          logger.error('Invalid Reserva configuration. Fix the reported fields before building.');
          throw error;
        }

        let routeOptions: ReturnType<typeof validateRouteOptions>;
        try {
          routeOptions = validateRouteOptions({ routePrefix: options.routePrefix });
        } catch (error) {
          logger.error('Invalid Reserva route options. Fix routePrefix before building.');
          throw error;
        }

        const prefix = normalizeRoutePrefix(routeOptions.routePrefix ?? '');
        const groupFlags: ReservaRouteGroupFlags = {
          admin: validatedConfig.routes?.admin ?? true,
          ops: validatedConfig.routes?.ops ?? true,
          manage: validatedConfig.routes?.manage ?? true,
        };
        const resolvedRouteConfig = resolveRouteConfig(prefix, groupFlags);

        const entrypoint = runtimePath(config.root, options.runtimeEntrypoint);
        if (!existsSync(entrypoint)) {
          throw new Error(`Reserva runtimeEntrypoint does not exist: ${entrypoint}`);
        }

        updateConfig({
          vite: {
            plugins: [runtimeVirtualPlugin(entrypoint), routeConfigVirtualPlugin(resolvedRouteConfig)],
          },
        });

        if (options.envSchema !== false) {
          updateConfig({ env: { schema: reservaSecretEnvSchema } });
        }

        // Disabled groups are simply never injected; routePath already carries the resolved
        // prefix, so every mounted pattern and every URL the components/handlers render agree.
        for (const route of enabledRouteManifest(groupFlags)) {
          injectRoute({
            pattern: routePath(route, prefix),
            entrypoint: routeEntrypoint(route.entrypoint),
            prerender: false,
          });
        }
      },
      'astro:server:setup': ({ logger }) => {
        // Discoverability only, not the guard: defineCloudflareReservaRuntime's isolate-time check
        // is what actually blocks a stale schema. No child-process wrangler here — auto-applying
        // migrations from the integration would be surprising and wrong against a remote database.
        logger.info(
          'Reserva: run `bunx reserva-migrate --local` before your first request to apply reserva\'s migrations '
          + '(it points Wrangler at reserva\'s packaged migrations/ folder itself — no d1_databases[].migrations_dir edit needed).',
        );
      },
      'astro:config:done': ({ config, injectTypes, logger }) => {
        // Exact match only: a substring/case-insensitive check both false-positives on adapters with
        // "cloudflare" in the name and false-negatives on legitimate forks with a different name.
        // This is advisory, not a hard gate — untested adapters may still work.
        if (config.adapter?.name !== '@astrojs/cloudflare') {
          logger.warn(
            `Reserva is built for @astrojs/cloudflare >= 14 (Workers runtime, D1 bindings via `
            + `'cloudflare:workers'). Detected adapter: ${config.adapter?.name ?? 'none'}. `
            + 'Other adapters are untested and may not provide the bindings reserva expects.',
          );
        }
        // Both output modes work: since Astro 5, 'static' plus an adapter renders
        // prerender:false injected routes on demand, so a static site can mount
        // Reserva without switching its own pages to server rendering.

        injectTypes({ filename: 'reserva.d.ts', content: virtualRuntimeTypes + virtualConfigTypes });
      },
    },
  };
}

export { virtualRuntimeId, virtualConfigId };
export type { ClientConfig, ResolvedClientConfig };
export default reserva;
