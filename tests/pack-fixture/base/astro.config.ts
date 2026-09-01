import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import reserva from '@reservajs/astro';
import config from './reserva.config';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ configPath: './wrangler.jsonc' }),
  integrations: [
    reserva({ config, runtimeEntrypoint: './runtime.ts' }),
  ],
});
