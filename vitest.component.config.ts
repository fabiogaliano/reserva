import { fileURLToPath } from 'node:url';
import { getViteConfig } from 'astro/config';
import { reserva } from './src/integration';
import { config } from './tests/fixtures';

// Needs Astro's real Vite pipeline (via getViteConfig) to render `.astro` components that read
// the request at render time, since text-matching the source isn't enough. Kept separate so the
// plain config's tests don't pay this transform's overhead.
export default getViteConfig(
  {
    test: {
      include: ['tests/component/**/*.test.ts'],
    },
  },
  {
    integrations: [
      reserva({ config, runtimeEntrypoint: fileURLToPath(new URL('./tests/component/fixtures/runtime.ts', import.meta.url)) }),
    ],
  },
);
