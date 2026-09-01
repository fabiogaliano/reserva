import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { workspaceAlias } from './vitest.workspace-alias';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
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
      include: ['tests/workers/**/*.test.ts'],
      setupFiles: ['tests/workers/setup.ts'],
    },
  };
});
