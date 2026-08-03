import { defineConfig, devices } from '@playwright/test';

// The webServer readiness URL below hits the D1-backed availability API (not just `/`) with a
// real query: the plain HTTP listener can accept connections (and even render `/`, which never
// touches D1) before the D1 durable-object binding underneath it has finished initializing, so a
// request racing that narrow window can fail even once the server is otherwise "up". Pointing
// readiness here makes Playwright wait out that race once, instead of every spec's first request
// needing its own retry logic.
const readinessFrom = new Date().toISOString().slice(0, 10);
const readinessTo = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // WHY: specs share one database and one in-memory outbox; parallel workers would interleave bookings
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:4399',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // e2e-dev-server.ts (not a bare `astro dev`): `astro dev` itself detaches into a background
    // daemon and its own invoking process exits almost immediately — Playwright's readiness check
    // then loses a race against that exit, and a plain kill on teardown never reaches the actual
    // daemon (see the WHY comment at the top of that script for how this was confirmed). The
    // wrapper keeps one real process alive for Playwright to track and to kill, and also runs the
    // reset+migrate step before spawning `astro dev` — deliberately not in a Playwright
    // globalSetup, see that script's WHY comment for the empirically-confirmed reason (running the
    // migration as a child of Playwright's own process left the dev server's D1 binding unable to
    // see data that was verifiably on disk).
    command: 'bun e2e-dev-server.ts',
    cwd: 'examples/smoke-site',
    env: { BOOKKIT_E2E_PERSIST: '.wrangler-e2e' },
    url: `http://localhost:4399/api/booking/availability?tour=oldTown&people=2&from=${readinessFrom}&to=${readinessTo}`,
    reuseExistingServer: false,
    timeout: 120_000,
    // Without this, Playwright's default teardown is an immediate SIGKILL to the process group —
    // e2e-dev-server.ts's SIGTERM handler (which runs `astro dev stop`, the only thing that
    // actually reaches astro's detached daemon) would never get to run, and the daemon would
    // survive the "kill" exactly as it did before this option was added (confirmed empirically:
    // the port stayed bound after teardown until this was set).
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
