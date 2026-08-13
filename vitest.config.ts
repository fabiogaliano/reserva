import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // tests/workers: separate config with the Cloudflare Workers pool (vitest.workers.config.ts,
    // run via `bun run test:workers`). tests/component: separate config with Astro's Vite pipeline
    // wired in (vitest.component.config.ts) — this plain config has no `.astro` transform, so
    // importing a component here would fail to parse.
    exclude: ['tests/workers/**/*.test.ts', 'tests/component/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
