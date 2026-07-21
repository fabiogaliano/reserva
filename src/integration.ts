import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { AstroIntegration } from 'astro';
import type { Plugin } from 'vite';
import { validateConfig, type ClientConfig } from './core/config';

export interface BookkitIntegrationOptions {
  config: ClientConfig | unknown;
  runtimeEntrypoint: string | URL;
}

const virtualRuntimeId = 'virtual:bookkit/runtime';
const resolvedVirtualRuntimeId = '\0' + virtualRuntimeId;

const routeEntries = [
  ['/api/booking/availability', './routes/api/booking/availability.ts'],
  ['/api/booking/checkout', './routes/api/booking/checkout.ts'],
  ['/api/booking/webhooks/stripe', './routes/api/booking/webhooks/stripe.ts'],
  ['/api/booking/status', './routes/api/booking/status.ts'],
  ['/api/booking/manage', './routes/api/booking/manage.ts'],
  ['/api/booking/cancel', './routes/api/booking/cancel.ts'],
  ['/api/booking/reschedule', './routes/api/booking/reschedule.ts'],
  ['/api/booking/operator/cancel', './routes/api/booking/operator/cancel.ts'],
  ['/api/booking/operator/reschedule', './routes/api/booking/operator/reschedule.ts'],
  ['/api/booking/operator/no-show', './routes/api/booking/operator/no-show.ts'],
  ['/api/booking/feed', './routes/api/booking/feed.ts'],
  ['/booking/admin', './routes/booking/admin.ts'],
  ['/booking/manage', './routes/booking/manage.ts'],
  ['/booking-confirmation', './routes/booking-confirmation.ts'],
] as const;

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

        const entrypoint = runtimePath(config.root, options.runtimeEntrypoint);
        if (!existsSync(entrypoint)) {
          throw new Error(`Bookkit runtimeEntrypoint does not exist: ${entrypoint}`);
        }

        updateConfig({
          vite: {
            plugins: [runtimeVirtualPlugin(entrypoint)],
          },
        });

        for (const [pattern, relativePath] of routeEntries) {
          injectRoute({
            pattern,
            entrypoint: routeEntrypoint(relativePath),
            prerender: false,
          });
        }
      },
      'astro:config:done': ({ config }) => {
        if (!config.adapter?.name.toLowerCase().includes('cloudflare')) {
          throw new Error('Bookkit requires @astrojs/cloudflare and Cloudflare Workers deployment');
        }
        if (config.output !== 'server') {
          throw new Error("Bookkit requires Astro output: 'server'");
        }
      },
    },
  };
}

export { virtualRuntimeId };
export type { ClientConfig };
export default bookkit;
