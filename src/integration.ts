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
  type ReservaRouteGroupFlags,
  type ReservaVirtualConfig,
} from './routes-manifest.js';

// Where a consumer's runtime module lives unless it says otherwise. Conventional enough that the
// quickstart never has to mention the option at all.
const DEFAULT_RUNTIME_ENTRYPOINT = './src/reserva-runtime.ts';

export interface ReservaIntegrationOptions {
  config: ClientConfig | unknown;
  // Defaults to `./src/reserva-runtime.ts`, resolved against the Astro project root.
  runtimeEntrypoint?: string | URL;
  // Set to `false` to skip contributing reserva's secret names to the `astro:env` schema, e.g. if
  // the consumer already declares its own schema for these names. Defaults to on.
  envSchema?: boolean;
  // Prepended to every injected route pattern and every URL reserva renders. Normalized (leading
  // slash, no trailing) and validated; an Astro-only mounting option — route group flags live in `config.routes`.
  routePrefix?: string;
}

// Reserva's own secret names only. A provider adapter's keys (Stripe, Brevo, Google) belong to the
// consumer's `env.schema`, not here: this library cannot know which adapters a deployment wires up,
// and declaring them all made every site carry names it never sets. All optional, since every one of
// these enables a layer rather than gating startup. Declares names for typed access and build-time
// visibility only; it doesn't change how anything reads them.
const reservaSecretEnvSchema = {
  RESERVA_OPERATOR_SECRET: envField.string({ context: 'server', access: 'secret', optional: true }),
  RESERVA_CSRF_SECRET: envField.string({ context: 'server', access: 'secret', optional: true }),
  RESERVA_TOKEN_ENC_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
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

// Static declaration, like virtualRuntimeTypes above: the shape is fixed (validated config +
// resolved paths + group flags), only the values differ per-consumer, so this never needs to be
// regenerated per-build.
const virtualConfigTypes = `declare module '${virtualConfigId}' {
  import type { ReservaVirtualConfig } from '@reservajs/astro';
  const virtualConfig: ReservaVirtualConfig;
  export default virtualConfig;
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

// Resolved once per build/dev-server start from the validated config and the (normalized) prefix +
// group flags — unlike virtual:reserva/runtime, this has no dependency on the consumer's
// runtimeEntrypoint, so it can be serialized directly instead of re-exporting a file path. Plain
// JSON by construction: `ResolvedClientConfig` carries no functions.
function routeConfigVirtualPlugin(virtualConfig: ReservaVirtualConfig): Plugin {
  return {
    name: 'reserva-route-config',
    enforce: 'pre',
    resolveId(id) {
      return id === virtualConfigId ? resolvedVirtualConfigId : undefined;
    },
    load(id) {
      if (id !== resolvedVirtualConfigId) return undefined;
      return `export default ${JSON.stringify(virtualConfig)};`;
    },
  };
}

export function reserva(options: ReservaIntegrationOptions): AstroIntegration {
  return {
    name: 'reserva',
    hooks: {
      'astro:config:setup': ({ command, config, injectRoute, logger, updateConfig }) => {
        // The one validation pass: what lands here is what `virtual:reserva/config` serializes and
        // what the runtime module reads back, so there is no second config source to drift from it.
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
        // `astro build` and `astro preview` both report a command other than 'dev', so only output
        // built by the dev server ever carries `dev: true`.
        const resolvedRouteConfig = resolveRouteConfig(prefix, groupFlags, command === 'dev');

        const entrypoint = runtimePath(config.root, options.runtimeEntrypoint ?? DEFAULT_RUNTIME_ENTRYPOINT);
        if (!existsSync(entrypoint)) {
          throw new Error(`Reserva runtimeEntrypoint does not exist: ${entrypoint}`);
        }

        updateConfig({
          vite: {
            plugins: [
              runtimeVirtualPlugin(entrypoint),
              routeConfigVirtualPlugin({ config: validatedConfig, routes: resolvedRouteConfig }),
            ],
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
