import { defineConfig } from 'vitest/config';
import { workspaceAlias } from './vitest.workspace-alias';

export default defineConfig({
  resolve: { alias: workspaceAlias },
  test: {
    include: ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    // tests/workers needs the Cloudflare Workers pool; tests/component needs Astro's Vite
    // pipeline for `.astro` transforms, which this plain config lacks and would fail to parse.
    exclude: ['tests/workers/**/*.test.ts', 'tests/component/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
