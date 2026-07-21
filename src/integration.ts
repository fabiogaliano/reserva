import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { AstroIntegration } from 'astro';
import { envField } from 'astro/config';
import type { Plugin } from 'vite';
import { validateConfig, type ClientConfig } from './core/config';
import {
  enabledRouteManifest,
  normalizeRoutePrefix,
  resolveRouteConfig,
  routePath,
  validateRouteOptions,
  type BookkitResolvedRouteConfig,
  type BookkitRouteGroupFlags,
} from './routes-manifest';

export interface BookkitIntegrationOptions {
  config: ClientConfig | unknown;
  runtimeEntrypoint: string | URL;
  // Set to `false` to skip contributing bookkit's secret names to the `astro:env` schema, e.g. if
  // the consumer already declares its own schema for these names. Defaults to on.
  envSchema?: false;
  // Prepended to every injected route pattern, and to every URL bookkit's own components/handlers
  // render (widget endpoints, manage/admin page links and form actions, the Stripe webhook path).
  // Normalized via `normalizeRoutePrefix` (leading slash, no trailing slash, ''/'/' => none);
  // validated first via Zod (see `validateRouteOptions`) to reject obviously broken values.
  routePrefix?: string;
  // Feature groups that can be turned off. `admin` = the admin dashboard route; `ops` = the
  // Tourflow feed/operator routes. Public booking API + customer manage routes are load-bearing and
  // always mounted (see routes-manifest.ts's `isRouteEnabled`). Both default to `true`.
  routes?: { admin?: boolean; ops?: boolean };
}

// Canonical secret names for bookkit's optional providers, sourced from scripts/manual-*.ts (the
// existing hand-rolled env var conventions for Stripe/Brevo/Google) and TOURFLOW_SHARED_SECRET
// (already used in examples/runtime.ts and the README). All optional: every provider is opt-in, so
// a consumer wiring up only Stripe must not fail env validation over a missing Brevo/Google key.
// This only declares the names for typed access and build-time visibility — it does not change how
// providers or `secrets()` read them; see README "Secrets and astro:env" for the full contract.
const bookkitSecretEnvSchema = {
  STRIPE_SECRET_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
  STRIPE_WEBHOOK_SECRET: envField.string({ context: 'server', access: 'secret', optional: true }),
  BREVO_API_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
  TOURFLOW_SHARED_SECRET: envField.string({ context: 'server', access: 'secret', optional: true }),
  GOOGLE_SA_EMAIL: envField.string({ context: 'server', access: 'secret', optional: true }),
  GOOGLE_SA_PRIVATE_KEY: envField.string({ context: 'server', access: 'secret', optional: true }),
  GOOGLE_IMPERSONATE_EMAIL: envField.string({ context: 'server', access: 'secret', optional: true }),
};

const virtualRuntimeId = 'virtual:bookkit/runtime';
const resolvedVirtualRuntimeId = '\0' + virtualRuntimeId;

// Static declaration (no codegen needed): the virtual module always re-exports whatever the
// consumer's runtimeEntrypoint default-exports, which is a BookkitRuntimeDefinition (aliased
// as BookkitRuntime) regardless of which entrypoint file is wired up.
const virtualRuntimeTypes = `declare module '${virtualRuntimeId}' {
  import type { BookkitRuntime } from 'bookkit/runtime';
  const runtime: BookkitRuntime;
  export default runtime;
}
`;

const virtualConfigId = 'virtual:bookkit/config';
const resolvedVirtualConfigId = '\0' + virtualConfigId;

// Static declaration, like virtualRuntimeTypes above: the shape is fixed (resolved paths + group
// flags), only the values differ per-consumer, so this never needs to be regenerated per-build.
const virtualConfigTypes = `declare module '${virtualConfigId}' {
  import type { BookkitResolvedRouteConfig } from 'bookkit';
  const config: BookkitResolvedRouteConfig;
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
    name: 'bookkit-runtime-entrypoint',
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

function routeEntrypoint(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

// Resolved once per build/dev-server start from the (validated, normalized) prefix + group flags —
// unlike virtual:bookkit/runtime, this has no dependency on the consumer's runtimeEntrypoint, so it
// can be serialized directly instead of re-exporting a file path.
function routeConfigVirtualPlugin(resolvedRouteConfig: BookkitResolvedRouteConfig): Plugin {
  return {
    name: 'bookkit-route-config',
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

export function bookkit(options: BookkitIntegrationOptions): AstroIntegration {
  return {
    name: 'bookkit',
    hooks: {
      'astro:config:setup': ({ config, injectRoute, logger, updateConfig }) => {
        try {
          validateConfig(options.config);
        } catch (error) {
          logger.error('Invalid Bookkit configuration. Fix the reported fields before building.');
          throw error;
        }

        let routeOptions: ReturnType<typeof validateRouteOptions>;
        try {
          routeOptions = validateRouteOptions({ routePrefix: options.routePrefix, routes: options.routes });
        } catch (error) {
          logger.error('Invalid Bookkit route options. Fix routePrefix/routes before building.');
          throw error;
        }

        const prefix = normalizeRoutePrefix(routeOptions.routePrefix ?? '');
        const groupFlags: BookkitRouteGroupFlags = {
          admin: routeOptions.routes?.admin ?? true,
          ops: routeOptions.routes?.ops ?? true,
        };
        const resolvedRouteConfig = resolveRouteConfig(prefix, groupFlags);

        const entrypoint = runtimePath(config.root, options.runtimeEntrypoint);
        if (!existsSync(entrypoint)) {
          throw new Error(`Bookkit runtimeEntrypoint does not exist: ${entrypoint}`);
        }

        updateConfig({
          vite: {
            plugins: [runtimeVirtualPlugin(entrypoint), routeConfigVirtualPlugin(resolvedRouteConfig)],
          },
        });

        if (options.envSchema !== false) {
          updateConfig({ env: { schema: bookkitSecretEnvSchema } });
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
        // Discoverability only, not the guard: defineCloudflareBookkitRuntime's isolate-time check
        // is what actually blocks a stale schema. No child-process wrangler here — auto-applying
        // migrations from the integration would be surprising and wrong against a remote database.
        logger.info(
          'Bookkit: point wrangler.jsonc\'s d1_databases[].migrations_dir at bookkit\'s migrations/ folder, '
          + 'then run `bunx bookkit-migrate --local` (wraps `wrangler d1 migrations apply`) before your first request.',
        );
      },
      'astro:config:done': ({ config, injectTypes }) => {
        if (!config.adapter?.name.toLowerCase().includes('cloudflare')) {
          throw new Error('Bookkit requires @astrojs/cloudflare and Cloudflare Workers deployment');
        }
        // Both output modes work: since Astro 5, 'static' plus an adapter renders
        // prerender:false injected routes on demand, so a static site can mount
        // Bookkit without switching its own pages to server rendering.

        injectTypes({ filename: 'bookkit.d.ts', content: virtualRuntimeTypes + virtualConfigTypes });
      },
    },
  };
}

export { virtualRuntimeId, virtualConfigId };
export type { ClientConfig };
export default bookkit;
