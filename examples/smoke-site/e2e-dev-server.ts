#!/usr/bin/env bun
// Playwright's webServer must own the process tree it tears down, but Astro backgrounds its dev
// server in detected agent environments, detaching it (and its workerd child) from Playwright.
// This wrapper keeps Astro in the foreground and forwards shutdown to the owned child.
//
// Migration runs here, synchronously, before spawning `astro dev` -- not in Playwright's
// globalSetup. Running it there leaves the dev server's D1 binding unable to see freshly applied
// migrations; running it one process level removed from Playwright never reproduces that.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const persistDir = process.env.RESERVA_E2E_PERSIST;
if (!persistDir) throw new Error('e2e-dev-server.ts requires RESERVA_E2E_PERSIST to be set');

// Fresh per run: wrangler and @cloudflare/vite-plugin both nest the actual sqlite state under
// <dir>/v3, so removing the whole isolated dir guarantees migrations replay against an empty
// database every run — this is the reset the two-consecutive-runs check verifies.
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
