export {};

type Env = Record<string, string | undefined>;
type GoogleProvider = new (options: Record<string, unknown>) => { listEvents(fromUtc: string, toUtc: string): Promise<unknown[]> };

const env = ((globalThis as { Bun?: { env: Env } }).Bun?.env ?? {}) as Env;
const value = (...names: string[]): string | undefined => names.map((name) => env[name]?.trim()).find(Boolean);
const calendarId = value('GOOGLE_CALENDAR_ID');
const clientEmail = value('GOOGLE_SA_EMAIL');
const privateKey = value('GOOGLE_SA_PRIVATE_KEY');
const impersonateEmail = value('GOOGLE_IMPERSONATE_EMAIL');
const missing = [
  calendarId ? undefined : 'GOOGLE_CALENDAR_ID',
  clientEmail ? undefined : 'GOOGLE_SA_EMAIL',
  privateKey ? undefined : 'GOOGLE_SA_PRIVATE_KEY',
  impersonateEmail ? undefined : 'GOOGLE_IMPERSONATE_EMAIL',
].filter((name): name is string => name !== undefined);

async function loadProvider(): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (const path of ['../src/providers/calendar-google/index.ts', '../src/providers/google.ts', '../src/providers/calendar-google.ts']) {
    try {
      return await import(path);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Google Calendar provider entry point was not found');
}

if (missing.length > 0) {
  console.log(`manual-google: skipped (missing ${missing.join(', ')})`);
} else {
  try {
    const module = await loadProvider();
    const exported = module.GoogleCalendarProvider ?? module.CalendarGoogleProvider ?? module.GoogleProvider ?? module.default;
    if (typeof exported !== 'function') throw new Error('Google Calendar provider export was not found');
    const provider = new (exported as GoogleProvider)({
      calendarId: calendarId!,
      serviceAccountEmail: clientEmail!,
      serviceAccountPrivateKey: privateKey!.replace(/\\n/g, '\n'),
      impersonateEmail: impersonateEmail!,
    });
    const from = new Date();
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
    const events = await provider.listEvents(from.toISOString(), to.toISOString());
    console.log(`manual-google: ok (${events.length} event(s) in the next 24 hours)`);
  } catch {
    console.error('manual-google: failed');
    process.exitCode = 1;
  }
}
