import type { EmailProvider } from '../../core/events.js';

// Frozen singleton rather than a fresh object per call: the provider holds no state, and freezing
// makes an accidental monkey-patch by a consumer fail loudly instead of silently affecting every
// other caller.
const provider: EmailProvider = Object.freeze({ send: async () => undefined });

export function emailNone(): EmailProvider { return provider; }
