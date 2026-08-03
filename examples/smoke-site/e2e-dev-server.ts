#!/usr/bin/env bun
// Playwright's webServer (see playwright.config.ts) spawns one process, waits for it to become
// reachable, and kills it on teardown — a model `astro dev` doesn't actually fit. Astro 7's CLI
// starts (or attaches to) a detached background daemon and then the CLI invocation itself exits
// almost immediately, even without `--background` (confirmed empirically: `ps` shows the daemon
// surviving under its own pid after the invoking process is gone). Two consequences without this
// wrapper:
//   1. Playwright's readiness race loses to that fast exit ("Process from config.webServer exited
//      early"), even though the server is genuinely coming up.
//   2. On teardown, Playwright signals the process it spawned — which is not the daemon holding
//      the port — so the port stays held. This is what orphaned port 4399 under the previous
//      e2e-server.ts design too; that script's destructive `.wrangler/state` backup/restore was a
//      separate bug layered on top of this same root cause.
// This wrapper keeps a real, signal-observing process alive for Playwright to track, and on
// SIGTERM/SIGINT runs the CLI's own `astro dev stop` — the one operation documented to actually
// reach and stop the daemon — before exiting itself.
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

const persistDir = process.env.BOOKKIT_E2E_PERSIST;
if (!persistDir) throw new Error('e2e-dev-server.ts requires BOOKKIT_E2E_PERSIST to be set');

// Fresh per run: wrangler and @cloudflare/vite-plugin both nest the actual sqlite state under
// <dir>/v3, so removing the whole isolated dir guarantees migrations replay against an empty
// database every run — this is the reset the two-consecutive-runs check in the plan verifies.
rmSync(new URL(persistDir, import.meta.url), { recursive: true, force: true });

const migrateResult = spawnSync(
  'bun',
  ['../../scripts/bookkit-migrate.ts', '--local', '--persist-to', persistDir],
  { stdio: 'inherit' },
);
if (migrateResult.status !== 0) {
  throw new Error(`bookkit-migrate exited with status ${migrateResult.status}`);
}

const astroBin = fileURLToPath(new URL('../../node_modules/.bin/astro', import.meta.url));

spawn(astroBin, ['dev', '--port', '4399'], { stdio: 'inherit', env: process.env });

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  // Synchronous on purpose: Playwright waits for this process to exit before treating teardown as
  // done, so the daemon must already be stopped (and the port released) by the time it returns.
  spawnSync(astroBin, ['dev', 'stop'], { stdio: 'inherit' });
  process.exit(0);
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// Nothing above keeps the event loop alive on its own (the child's "inherit" stdio doesn't hold a
// reference once it exits, and signal listeners don't count as a pending handle) — without this,
// the wrapper itself would exit right behind the CLI invocation, reproducing the exact problem it
// exists to avoid.
setInterval(() => {}, 1 << 30);
