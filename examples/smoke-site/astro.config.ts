import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import bookkit from '../../src/index.ts';
import config from './src/config';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ configPath: './wrangler.jsonc' }),
  integrations: [
    bookkit({
      config,
      runtimeEntrypoint: new URL('./src/runtime.ts', import.meta.url),
    }),
  ],
});
