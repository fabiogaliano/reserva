import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import bookkit from '../src/index';
import config from './client-config';

export default defineConfig({
  output: 'server',
  adapter: cloudflare(),
  integrations: [
    // The explicit runtime module keeps provider instances and secrets out of serialized Astro config.
    bookkit({ config, runtimeEntrypoint: './runtime.ts' }),
  ],
});
