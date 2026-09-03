import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getViteConfig } from 'astro/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { reserva } from './src/integration';
import { config } from './tests/fixtures';
import { workspaceAlias } from './vitest.workspace-alias';

const root = dirname(fileURLToPath(import.meta.url));

// One config, three projects, because each needs a different runner: `unit` is plain Node, the
// `.astro` components need Astro's own Vite pipeline to transform, and the D1 tests need the
// Cloudflare Workers pool. Selecting projects by name keeps the fast loop fast — `bun run test`
// skips `workers`, which downloads and boots workerd.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias: workspaceAlias },
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
          exclude: ['tests/workers/**/*.test.ts', 'tests/component/**/*.test.ts'],
        },
      },
      getViteConfig(
        { test: { name: 'component', include: ['tests/component/**/*.test.ts'] } },
        {
          integrations: [
            reserva({ config, runtimeEntrypoint: resolve(root, 'tests/component/fixtures/runtime.ts') }),
          ],
        },
      ),
      async () => {
        const migrations = await readD1Migrations(resolve(root, 'migrations'));
        return {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: resolve(root, 'wrangler.test.jsonc') },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            }),
          ],
          resolve: { alias: workspaceAlias },
          test: {
            name: 'workers',
            include: ['tests/workers/**/*.test.ts'],
            setupFiles: ['tests/workers/setup.ts'],
          },
        };
      },
    ],
    coverage: { provider: 'v8', reporter: ['text', 'html'] },
  },
});
