export {};

type Env = Record<string, string | undefined>;
type StripeProvider = new (options: Record<string, unknown>) => { getSession?: (sessionId: string) => Promise<unknown> };

const env = ((globalThis as { Bun?: { env: Env } }).Bun?.env ?? {}) as Env;
const value = (...names: string[]): string | undefined => names.map((name) => env[name]?.trim()).find(Boolean);
const secretKey = value('STRIPE_SECRET_KEY');
const webhookSecret = value('STRIPE_WEBHOOK_SECRET');
const sessionId = value('STRIPE_SESSION_ID');
const missing = [
  secretKey ? undefined : 'STRIPE_SECRET_KEY',
  webhookSecret ? undefined : 'STRIPE_WEBHOOK_SECRET',
].filter((name): name is string => name !== undefined);

async function loadProvider(): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (const path of ['../src/providers/payments-stripe/index.ts', '../src/providers/stripe.ts', '../src/providers/payments-stripe.ts']) {
    try {
      return await import(path);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Stripe provider entry point was not found');
}

if (missing.length > 0) {
  console.log(`manual-stripe: skipped (missing ${missing.join(', ')})`);
} else {
  try {
    const module = await loadProvider();
    const exported = module.StripePaymentProvider ?? module.PaymentsStripeProvider ?? module.StripeProvider ?? module.default;
    if (typeof exported !== 'function') throw new Error('Stripe provider export was not found');
    const provider = new (exported as StripeProvider)({ secretKey, webhookSecret });
    if (sessionId) {
      if (typeof provider.getSession !== 'function') throw new Error('Stripe provider cannot retrieve sessions');
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
