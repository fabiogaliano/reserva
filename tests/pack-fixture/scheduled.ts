// Plan 020 (step 7/8): the consumer-owned custom Worker entrypoint for the scheduled reconciliation
// sweep — a small, SEPARATE Worker script (its own wrangler config, its own `main`) rather than a
// wrapper around the Astro adapter's generated entry. @astrojs/cloudflare 14's build always
// regenerates its own redirected wrangler config with `main` forced to its own compiled entry (see
// examples/smoke-site/worker/README.md for the investigation) — patching that generated file would
// be re-fought on every build and risks silently losing the adapter's injected routes/static
// assets/bindings (the exact STOP condition this plan calls out). A standalone cron Worker sharing
// the same BOOKKIT_DB D1 binding avoids the adapter entirely: the site's own entrypoint (and every
// route/asset/binding it injects) is never touched.
//
// runtime.createContext falls back to the `cloudflare:workers` env/waitUntil globals whenever no
// Astro `locals` are supplied (see src/runtime-context.ts getWorkerEnv/getWorkerWaitUntil) — those
// globals work the same way in any Module Worker handler, scheduled() included, so this needs no
// extra plumbing beyond the runtime definition every other entrypoint already shares.
import { runReconciliation } from 'bookkit/runtime';
import runtime from './runtime';

export default {
  async scheduled(_controller: ScheduledController, _env: unknown, ctx: ExecutionContext): Promise<void> {
    const context = await runtime.createContext({ request: new Request('https://bookkit-scheduled.invalid/') });
    ctx.waitUntil(runReconciliation(context));
  },
};
