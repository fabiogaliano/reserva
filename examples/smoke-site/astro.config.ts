import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import bookkit from '../../src/index.ts';
import config from '../client-config';
import runtime from '../runtime';

export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  integrations: [bookkit({ config, runtimeEntrypoint: new URL('../runtime.ts', import.meta.url) })],
  vite: {
    define: {
      __BOOKKIT_SMOKE_RUNTIME__: JSON.stringify(Boolean(runtime)),
    },
  },
});
