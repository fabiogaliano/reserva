import { defineConfig, devices } from '@playwright/test';

// Readiness hits the D1-backed availability API, not `/`: the HTTP listener can accept
// connections and even render `/` before the D1 durable-object binding finishes initializing.
// Waiting on a real D1 query here avoids every spec needing its own retry for that race.
const readinessFrom = new Date().toISOString().slice(0, 10);
const readinessTo = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // specs share one database and one in-memory outbox; parallel workers would interleave bookings
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
    // Not a bare `astro dev`: Astro auto-detaches in agent environments, so Playwright would lose
    // ownership of the server and its Miniflare child. Runs reset+migrate here, not in Playwright's
    // globalSetup, because a separate process left the dev server's D1 binding unable to see the data.
    command: 'bun e2e-dev-server.ts',
    cwd: 'examples/smoke-site',
    env: { RESERVA_E2E_PERSIST: '.wrangler-e2e' },
    url: `http://localhost:4399/api/booking/availability?tour=oldTown&people=2&from=${readinessFrom}&to=${readinessTo}`,
    reuseExistingServer: false,
    timeout: 120_000,
    // Without this, Playwright's default teardown is an immediate SIGKILL to the process group,
    // so the wrapper cannot let Astro close Miniflare and reap workerd before it exits.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
  },
});
