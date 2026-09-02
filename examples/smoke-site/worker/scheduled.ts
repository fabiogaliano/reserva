// Separate Worker because the Astro adapter's generated entry exports only `fetch`.
// It shares only the D1 binding (see ./wrangler.jsonc) with the site Worker.
// Secrets must be configured on this Worker too — they are not inherited from the site Worker.
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
