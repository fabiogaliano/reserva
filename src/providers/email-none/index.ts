import type { EmailProvider } from '../../core/events.js';

// Frozen singleton rather than a fresh object per call: the provider holds no state, and freezing
// makes an accidental monkey-patch by a consumer fail loudly instead of silently affecting every
// other caller.
const provider: EmailProvider = Object.freeze({
  send: async () => undefined,
  // Logged rather than silent: this provider is how a deployment says "no email transport yet",
  // and an operational alert dropped without a trace is the one case that matters.
  sendMessage: async (message) => { console.info('reserva email-none: message dropped', { to: message.to, subject: message.subject }); },
});

export function emailNone(): EmailProvider { return provider; }
