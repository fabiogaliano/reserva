// The scheduled reconciliation sweep, as a small, SEPARATE Worker script rather than a wrapper
// around the Astro adapter's own generated entrypoint.
//
// Why separate: @astrojs/cloudflare 14's build (`astro build`) always writes its own redirected
// wrangler config (`dist/server/wrangler.json`, picked up automatically via
// `.wrangler/deploy/config.json`) with `main` hardcoded to its own compiled `entry.mjs` — there is
// no supported adapter option to point that at a custom file, and hand-patching the generated
// config would be silently overwritten on the next build. Wrapping `entry.mjs` after the fact was
// considered and rejected: it would have to be re-applied by a bespoke post-build step on every
// deploy, and any mistake in that step risks losing the adapter's injected routes, static assets,
// or bindings. A standalone cron Worker
// that only shares the RESERVA_DB D1 binding (see ./wrangler.jsonc) never touches the site's own
// entrypoint at all, so the site's HTTP serving cannot regress by construction.
//
// This is installed and deployed once by the technical operator (`wrangler deploy` from this
// directory — see the smoke-site README). Cloudflare secrets are per Worker, so a production copy
// must configure every credential read by the shared runtime's provider factory on this Worker too;
// sharing D1 does not inherit the site Worker's payment/calendar/email/ops/alert secrets.
//
// runtime.createContext falls back to the `cloudflare:workers` env/waitUntil globals whenever no
// Astro `locals` are supplied (src/runtime-context.ts's getWorkerEnv/getWorkerWaitUntil) — those
// globals are populated by the Workers runtime for any Module Worker handler, scheduled() included,
// so reusing the site's own runtime definition here needs no extra plumbing.
import { runReconciliation } from '../../../src/runtime';
import runtime from '../src/runtime';

export default {
  async scheduled(_controller: ScheduledController, _env: unknown, _ctx: ExecutionContext): Promise<void> {
    try {
      const context = await runtime.createContext({ request: new Request('https://reserva-scheduled.invalid/') });
      const summary = await runReconciliation(context, { requireAlertSink: true });
      context.logger.info?.('reserva scheduled reconciliation summary', { ...summary });
    } catch (error) {
      console.error('reserva scheduled reconciliation failed', { lifecycle: 'failed', error: String(error) });
      throw error;
    }
  },
};
