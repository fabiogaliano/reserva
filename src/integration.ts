import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { AstroIntegration } from 'astro';
import type { Plugin } from 'vite';
import { validateConfig, type ClientConfig } from './core/config';
import { routeManifest, routePath } from './routes-manifest';

export interface BookkitIntegrationOptions {
  config: ClientConfig | unknown;
  runtimeEntrypoint: string | URL;
}

const virtualRuntimeId = 'virtual:bookkit/runtime';
const resolvedVirtualRuntimeId = '\0' + virtualRuntimeId;

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

        for (const route of routeManifest) {
          injectRoute({
            pattern: routePath(route),
            entrypoint: routeEntrypoint(route.entrypoint),
            prerender: false,
          });
        }
      },
      'astro:config:done': ({ config }) => {
        if (!config.adapter?.name.toLowerCase().includes('cloudflare')) {
          throw new Error('Bookkit requires @astrojs/cloudflare and Cloudflare Workers deployment');
        }
        // Both output modes work: since Astro 5, 'static' plus an adapter renders
        // prerender:false injected routes on demand, so a static site can mount
        // Bookkit without switching its own pages to server rendering.
      },
    },
  };
}

export { virtualRuntimeId };
export type { ClientConfig };
export default bookkit;
