import { fileURLToPath } from 'node:url';
import { getViteConfig } from 'astro/config';
import { bookkit } from './src/integration';
import { config } from './tests/fixtures';

// Separate from vitest.config.ts on purpose: rendering an actual `.astro` component (plan 009's
// "component render test" requirement — src/components/AdminDashboard.astro now reads the request
// at render time, so text-matching its source like tests/ui-booking-widget.test.ts does isn't
// enough) needs Astro's real Vite pipeline (the `.astro` compiler plus bookkit's own
// virtual:bookkit/runtime and virtual:bookkit/config plugins, wired in by the bookkit integration
// below) — getViteConfig() is Astro's documented way to get that pipeline into Vitest. Every other
// test file has no such need and stays on the plain config, so this doesn't add Astro's transform
// overhead (or risk) to the whole suite.
export default getViteConfig(
  {
    test: {
      include: ['tests/component/**/*.test.ts'],
    },
  },
  {
    integrations: [
      bookkit({ config, runtimeEntrypoint: fileURLToPath(new URL('./tests/component/fixtures/runtime.ts', import.meta.url)) }),
    ],
  },
);
