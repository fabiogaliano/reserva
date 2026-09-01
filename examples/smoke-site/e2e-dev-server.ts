#!/usr/bin/env bun
// Playwright's webServer (see playwright.config.ts) must own the process tree it tears down. Astro
// 7 auto-backgrounds its dev server in detected agent environments, detaching the Astro process
// and its Miniflare workerd child from Playwright. Stopping the detached Astro process does not
// reliably reap workerd; a survivor keeps the old `.wrangler-e2e` database open and can hit EPIPE
// after the next run resets that directory. This wrapper sets Astro's background-child marker so
// the CLI stays in the foreground, then forwards shutdown directly to that owned child.
//
// The reset+migrate step runs here, synchronously, before spawning `astro dev` — NOT in
// Playwright's globalSetup. Empirically confirmed (by bisecting with a minimal Playwright config)
// that running `wrangler d1 migrations apply` via globalSetup's `execFileSync`, i.e. as a child of
// Playwright's own long-lived test-runner process, leaves the dev server's D1 binding unable to
// see the migrations that were just applied — the sqlite file on disk is correct (verified by
// querying it directly with the sqlite3 CLI while the dev server is failing), but the worker's own
// D1 binding reports every migration missing, consistently, for the server's entire lifetime. The
// same migrate step run from a plain script or shell, one level removed from Playwright's process,
// never reproduces this. Folding the migration into this wrapper — which Playwright launches as
// the webServer's process directly, not as a side effect of globalSetup — avoids whatever in
// Playwright's process makes the miniflare/workerd D1 emulation misbehave, without depending on
// understanding that mechanism precisely.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const persistDir = process.env.RESERVA_E2E_PERSIST;
if (!persistDir) throw new Error('e2e-dev-server.ts requires RESERVA_E2E_PERSIST to be set');

// Fresh per run: wrangler and @cloudflare/vite-plugin both nest the actual sqlite state under
// <dir>/v3, so removing the whole isolated dir guarantees migrations replay against an empty
// database every run — this is the reset the two-consecutive-runs check in the plan verifies.
rmSync(new URL(persistDir, import.meta.url), { recursive: true, force: true });

const migrateResult = spawnSync(
  'bun',
  ['../../scripts/reserva-migrate.ts', '--local', '--persist-to', persistDir],
  { stdio: 'inherit' },
);
if (migrateResult.status !== 0) {
  throw new Error(`reserva-migrate exited with status ${migrateResult.status}`);
}

const astroBin = fileURLToPath(new URL('../../node_modules/.bin/astro', import.meta.url));
const astro = spawn(astroBin, ['dev', '--port', '4399'], {
  stdio: 'inherit',
  env: { ...process.env, ASTRO_DEV_BACKGROUND: '1' },
});

let stopping = false;
let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

function exitAfterChild(code: number | null): void {
  if (forceKillTimer) clearTimeout(forceKillTimer);
  process.exit(stopping ? 0 : (code ?? 1));
}

astro.on('error', (error) => {
  console.error('Failed to start the Astro e2e server:', error);
  process.exit(1);
});
astro.on('exit', exitAfterChild);

function stop(): void {
  if (stopping) return;
  stopping = true;

  if (astro.exitCode !== null || astro.signalCode !== null) {
    process.exit(0);
  }

  astro.kill('SIGTERM');
  // Playwright gives this wrapper ten seconds for graceful shutdown. Leave enough margin for a
  // forced child exit while still ensuring no workerd process survives into the next test run.
  forceKillTimer = setTimeout(() => astro.kill('SIGKILL'), 8_000);
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
