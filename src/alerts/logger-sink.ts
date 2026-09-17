import type { OperationalAlert, OperationalAlertSink } from '../core/events.js';
import type { ReservaLogger } from '../context.js';

// The fallback when no email provider can send a standalone message: the incident still lands in
// the Worker logs with its full payload, and the cron keeps running instead of refusing to start.
export function loggerAlertSink(logger: ReservaLogger | undefined): OperationalAlertSink {
  return {
    async send(alert: OperationalAlert): Promise<void> {
      logger?.error?.('reserva operational alert', { ...alert });
    },
  };
}
