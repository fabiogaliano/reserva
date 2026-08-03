import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import bookkit from '../../src/index.ts';
import config from './src/config';

// e2e runs set BOOKKIT_E2E_PERSIST so the dev server reads/writes an isolated D1 state dir
// instead of `.wrangler/state` — the same directory the interactive `bun run demo` command uses.
// Resolved against this config file (not process.cwd()) so it lands in the same place regardless
// of which directory the dev server was launched from. `persistState` (not `platformProxy.persist`,
// which doesn't exist on this adapter version) is the option @astrojs/cloudflare v14 forwards
// straight through to @cloudflare/vite-plugin; that plugin appends a `v3` subdirectory itself, the
// same convention `wrangler d1 migrations apply --persist-to` uses, so the two layers agree on the
// same on-disk path without either side special-casing the suffix.
const e2ePersistPath = process.env.BOOKKIT_E2E_PERSIST;

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    configPath: './wrangler.jsonc',
    ...(e2ePersistPath ? { persistState: { path: fileURLToPath(new URL(e2ePersistPath, import.meta.url)) } } : {}),
  }),
  integrations: [
    bookkit({
      config,
      runtimeEntrypoint: new URL('./src/runtime.ts', import.meta.url),
    }),
  ],
});
