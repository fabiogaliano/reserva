import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import reserva from '../../src/index.ts';
import config from './src/config';

// e2e-dev-server.ts sets RESERVA_E2E_PERSIST and scripts/smoke-preview-test.ts sets
// RESERVA_PREVIEW_PERSIST, so each isolated probe reads/writes its own D1 state dir instead of
// `.wrangler/state` — the same directory the interactive `bun run demo` command uses, which
// neither probe should ever reset. Resolved against this config file (not process.cwd()) so it
// lands in the same place regardless of which directory the server was launched from.
// `persistState` (not `platformProxy.persist`, which doesn't exist on this adapter version) is the
// option @astrojs/cloudflare v14 forwards straight through to @cloudflare/vite-plugin; that plugin
// appends a `v3` subdirectory itself, the same convention `wrangler d1 migrations apply
// --persist-to` uses, so the two layers agree on the same on-disk path without either side
// special-casing the suffix.
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
