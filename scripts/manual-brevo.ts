export {};

type Env = Record<string, string | undefined>;
type BrevoProvider = new (options: Record<string, unknown>) => unknown;

const env = ((globalThis as { Bun?: { env: Env } }).Bun?.env ?? {}) as Env;
const value = (...names: string[]): string | undefined => names.map((name) => env[name]?.trim()).find(Boolean);
const apiKey = value('BREVO_API_KEY', 'SENDINBLUE_API_KEY');
const senderEmail = value('BREVO_SENDER_EMAIL', 'BREVO_FROM_EMAIL', 'SENDINBLUE_SENDER_EMAIL');
const senderName = value('BREVO_SENDER_NAME', 'BREVO_FROM_NAME');
const missing = [
  apiKey ? undefined : 'BREVO_API_KEY',
].filter((name): name is string => name !== undefined);

async function loadProvider(): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (const path of ['../src/providers/email-brevo/index.ts', '../src/providers/brevo.ts', '../src/providers/email-brevo.ts']) {
    try {
      return await import(path);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Brevo provider entry point was not found');
}

if (missing.length > 0) {
  console.log(`manual-brevo: skipped (missing ${missing.join(', ')})`);
} else {
  try {
    const module = await loadProvider();
    const exported = module.BrevoEmailProvider ?? module.EmailBrevoProvider ?? module.BrevoProvider ?? module.default;
    if (typeof exported !== 'function') throw new Error('Brevo provider export was not found');
    new (exported as BrevoProvider)({
      apiKey,
      ...(senderEmail ? { sender: { email: senderEmail, ...(senderName ? { name: senderName } : {}) } } : {}),
    });
    console.log('manual-brevo: ok (provider constructed)');
  } catch {
    console.error('manual-brevo: failed');
    process.exitCode = 1;
  }
}
