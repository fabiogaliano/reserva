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
  // Playwright polls one port (RESERVA_E2E_PORT) for readiness, so an e2e server that silently moved to the next
  // free port would leave the suite testing whichever other run already holds it — its database,
  // its bookings, and its shutdown mid-run. Fail to start instead.
  ...(process.env.RESERVA_E2E_PERSIST ? { vite: { server: { strictPort: true } } } : {}),
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
