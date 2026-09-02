import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import reserva from '../../src/index.ts';
import config from './src/config';

// Lets isolated test/preview runs use their own D1 state dir instead of the shared `.wrangler/state`.
// Resolved against this config file so the path is stable regardless of the launch cwd.
const isolatedPersistPath = process.env.RESERVA_E2E_PERSIST ?? process.env.RESERVA_PREVIEW_PERSIST;

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    configPath: './wrangler.jsonc',
    ...(isolatedPersistPath ? { persistState: { path: fileURLToPath(new URL(isolatedPersistPath, import.meta.url)) } } : {}),
  }),
  integrations: [
    reserva({
      config,
      runtimeEntrypoint: new URL('./src/runtime.ts', import.meta.url),
    }),
  ],
});
