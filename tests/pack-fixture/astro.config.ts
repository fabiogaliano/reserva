import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import bookkit from '@reservajs/astro';
import config from './bookkit.config';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ configPath: './wrangler.jsonc' }),
  integrations: [
    bookkit({ config, runtimeEntrypoint: './runtime.ts' }),
  ],
});
