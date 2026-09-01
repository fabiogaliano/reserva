#!/usr/bin/env bun
// Plan 015 decision 5: proves the BUILT smoke-site output actually serves traffic through the
// pinned @astrojs/cloudflare adapter's `astro preview` entrypoint. The Playwright suite's
// webServer (examples/smoke-site/e2e-dev-server.ts) only ever runs `astro dev` -- a bug that only
// manifests in the built worker (a route missing from the compiled manifest, an asset never
// emitted) would pass every existing suite unnoticed. Kept separate from Playwright: this is a
// single serve-and-probe smoke check, not a browser-driven spec, and it never touches Playwright's
// own webServer or its `.wrangler-e2e` state.
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const smokeSiteRoot = fileURLToPath(new URL('../examples/smoke-site/', import.meta.url));
// Isolated from both the interactive `bun run demo` state (.wrangler/state) and the Playwright e2e
// suite's own state (.wrangler-e2e) -- see astro.config.ts's BOOKKIT_PREVIEW_PERSIST wiring -- and
// on a different port than Playwright's fixed 4399, so the two probes can never collide.
const PERSIST_DIR = '.wrangler-preview-test';
const HOST = '127.0.0.1';
const PORT = 4398;
const baseUrl = `http://${HOST}:${PORT}`;

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(command, args, { cwd: smokeSiteRoot, stdio: 'inherit', env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status ?? 'null'} (signal ${result.signal ?? 'none'})`);
  }
}

// Fresh D1 state every run -- mirrors e2e-dev-server.ts's own reset, and for the same reason: a
// stale prior run's schema/rows must never leak into this run's readiness/availability assertions.
rmSync(new URL(PERSIST_DIR, `file://${smokeSiteRoot}`), { recursive: true, force: true });
run('bun', ['../../scripts/bookkit-migrate.ts', '--local', '--persist-to', PERSIST_DIR]);
run('bun', ['run', 'build']);

const astroBin = fileURLToPath(new URL('../node_modules/.bin/astro', import.meta.url));
const previewEnv: NodeJS.ProcessEnv = {
  ...process.env,
  BOOKKIT_PREVIEW_PERSIST: PERSIST_DIR,
  // Astro's CLI auto-backgrounds `preview` when it thinks an agent is driving it (isRunByAgent()
  // in astro/dist/cli/agent.js) -- any truthy value here defeats that heuristic, so this stays the
  // plain foreground server this script spawns, probes, and terminates itself, the same lifecycle
  // Playwright's own webServer expects (see playwright.config.ts's gracefulShutdown comment for
  // why `astro dev` needed a different wrapper -- `astro preview` has no such detached daemon).
  ASTRO_PREVIEW_BACKGROUND: '1',
};
const preview = spawn(astroBin, ['preview', '--host', HOST, '--port', String(PORT)], {
  cwd: smokeSiteRoot,
  stdio: 'inherit',
  env: previewEnv,
});

let exited = false;
preview.on('exit', () => { exited = true; });

async function waitForReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited) throw new Error('astro preview exited before becoming ready');
    try {
      // Any real HTTP response (not a connection error) proves the server -- and the D1 binding
      // behind it -- is actually up, the same "hit a real route, not just an accepting socket"
      // reasoning playwright.config.ts's own readiness URL comment gives for the dev-server probe.
      const response = await fetch(`${baseUrl}/`);
      if (response.status < 500) return;
    } catch {
      // Connection refused while the server is still starting -- retry.
    }
    if (Date.now() > deadline) throw new Error(`astro preview did not become ready within ${timeoutMs}ms`);
    await delay(250);
  }
}

async function requestOk(path: string): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`);
  if (response.status !== 200) throw new Error(`GET ${path} returned ${response.status}, expected 200`);
}

try {
  await waitForReady(30_000);

  await requestOk('/'); // the widget page
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  await requestOk(`/api/booking/availability?service=oldTown&quantity=2&from=${from}&to=${to}`); // a valid availability URL
  await requestOk('/booking/assets/bookkit.js'); // one Bookkit asset route

  console.log('smoke-preview-test: built smoke-site output served successfully through `astro preview`');
} finally {
  preview.kill('SIGTERM');
  const stopDeadline = Date.now() + 5_000;
  while (!exited && Date.now() < stopDeadline) await delay(100);
  if (!exited) preview.kill('SIGKILL');
}
