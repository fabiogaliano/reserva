export {};

import { stripe } from '@reservajs/stripe';

type Env = Record<string, string | undefined>;

const env = ((globalThis as { Bun?: { env: Env } }).Bun?.env ?? {}) as Env;
const value = (...names: string[]): string | undefined => names.map((name) => env[name]?.trim()).find(Boolean);
const secretKey = value('STRIPE_SECRET_KEY');
const webhookSecret = value('STRIPE_WEBHOOK_SECRET');
const sessionId = value('STRIPE_SESSION_ID');
const missing = [
  secretKey ? undefined : 'STRIPE_SECRET_KEY',
  webhookSecret ? undefined : 'STRIPE_WEBHOOK_SECRET',
].filter((name): name is string => name !== undefined);

if (missing.length > 0) {
  console.log(`manual-stripe: skipped (missing ${missing.join(', ')})`);
} else {
  try {
    const provider = stripe({ secretKey: secretKey!, webhookSecret: webhookSecret! });
    if (sessionId) {
      await provider.getSession(sessionId);
      console.log('manual-stripe: ok (session retrieved)');
    } else {
      console.log('manual-stripe: ok (provider constructed)');
    }
  } catch {
    console.error('manual-stripe: failed');
    process.exitCode = 1;
  }
}
