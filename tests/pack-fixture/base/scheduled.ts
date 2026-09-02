// A separate Worker (own wrangler config, own `main`), not a wrapper around the Astro adapter's
// generated entry -- that file is regenerated every build, so patching it risks losing injected
// routes/assets/bindings; createContext's cloudflare:workers fallback means scheduled() needs no extra plumbing.
import { runReconciliation } from '@reservajs/astro/runtime';
import runtime from './runtime';

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
