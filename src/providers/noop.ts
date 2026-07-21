import type { EmailProvider } from '../core/events';

export const noopEmailProvider: EmailProvider = Object.freeze({ send: async () => undefined });
export function createNoopEmailProvider(): EmailProvider { return noopEmailProvider; }
export const calendarInviteOnly = createNoopEmailProvider;
export const emailNone = createNoopEmailProvider;
