#!/usr/bin/env bun
// Extracts the quickstart's file blocks straight from README.md (never copied here), so drift
// between the docs and the library breaks this test instead of shipping silently.
//
// The README wires `@reservajs/stripe`, which needs a live Stripe account to complete a checkout,
// so the two lines that construct it are swapped for a local `PaymentProvider` on the same public
// port. Both swaps assert on exact source text, so a README edit that moves them fails here too.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PORT = 4397; // distinct from the demo (4321), Playwright (4399) and the preview probe (4398)
const baseUrl = `http://${HOST}:${PORT}`;

function fail(message: string): never {
  throw new Error(`quickstart-test: ${message}`);
}

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(command, args, { cwd, env: env ?? process.env, encoding: 'utf8' });
}

function mustRun(phase: string, command: string, args: string[], cwd: string): void {
  const result = run(command, args, cwd);
  if (result.status !== 0) fail(`[${phase}] \`${command} ${args.join(' ')}\` failed:\n${result.stdout}\n${result.stderr}`);
}

// A quickstart block is identified by a `// path` (or `// path — note`) first line naming where
// the file goes, matching what a reader would follow.
function quickstartFiles(): Map<string, string> {
  const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
  const start = readme.indexOf('\n## Quickstart\n');
  if (start < 0) fail('README.md has no "## Quickstart" section');
  const end = readme.indexOf('\n## ', start + 1);
  const section = readme.slice(start, end < 0 ? undefined : end);

  const files = new Map<string, string>();
  for (const match of section.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    const body = match[1] ?? '';
    const firstLine = body.slice(0, body.indexOf('\n'));
    const named = /^\/\/\s*([\w./-]+\.\w+)/.exec(firstLine);
    if (!named?.[1]) continue; // the `bun add` / `reserva-migrate` shell blocks, run explicitly below
    files.set(named[1], body);
  }
  return files;
}

const readmeFiles = quickstartFiles();
for (const expected of ['reserva.config.ts', 'astro.config.ts', 'src/reserva-runtime.ts', 'wrangler.jsonc']) {
  if (!readmeFiles.has(expected)) fail(`README quickstart no longer shows a \`${expected}\` block`);
}

function replaceOnce(source: string, needle: string, replacement: string, what: string): string {
  if (!source.includes(needle)) fail(`the README quickstart's runtime module no longer contains ${what}; update this script's substitution`);
  return source.replace(needle, replacement);
}

let runtimeModule = readmeFiles.get('src/reserva-runtime.ts')!;
runtimeModule = replaceOnce(
  runtimeModule,
  "import { stripe } from '@reservajs/stripe';",
  "import { simulatedPayments } from './payments';",
  'its `@reservajs/stripe` import',
);
runtimeModule = replaceOnce(
  runtimeModule,
  'payments: stripe({ secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET }),',
  'payments: simulatedPayments,',
  'its `stripe(...)` provider construction',
);

// Not shown in the README: Stripe can't be driven from CI, so this fills the same public
// `PaymentProvider` port instead. The amount lives in the session ref, not a module-level map, so
// verification works no matter which isolate answers `getSession`.
const simulatedPaymentsModule = `import type { PaymentProvider } from '@reservajs/astro/core';

export const simulatedPayments: PaymentProvider = {
  async createCheckout(booking) {
    const sessionRef = \`sim_\${booking.id}_\${booking.priceMinor}\`;
    return { url: \`https://payments.example/checkout/\${sessionRef}\`, sessionRef };
  },
  async parseWebhook(request) {
    return await request.json() as Awaited<ReturnType<PaymentProvider['parseWebhook']>>;
  },
  async getSession(sessionRef) {
    const amountTotal = Number(sessionRef.slice(sessionRef.lastIndexOf('_') + 1));
    return {
      id: sessionRef,
      status: 'complete',
      paymentStatus: 'paid',
      amountTotal,
      currency: 'eur',
      paymentRef: \`sim_payment_\${sessionRef}\`,
    };
  },
  async refund(paymentRef, expectedAmountMinor) {
    return { refundRef: \`sim_refund_\${paymentRef}\`, amountMinor: expectedAmountMinor };
  },
};
`;

mustRun('build', 'bun', ['run', 'build'], repoRoot);
mustRun('build', 'bun', ['run', '--filter', '@reservajs/stripe', 'build'], repoRoot);

const workDir = mkdtempSync(join(tmpdir(), 'reserva-quickstart-'));
const projectDir = join(workDir, 'site');
mkdirSync(projectDir, { recursive: true });

function pack(packageDir: string): string {
  const result = run('bun', ['pm', 'pack', '--quiet', '--destination', workDir], packageDir);
  if (result.status !== 0) fail(`[pack] \`bun pm pack\` failed:\n${result.stderr}`);
  const tarball = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).at(-1);
  if (!tarball || !existsSync(tarball)) fail(`[pack] could not determine the packed tarball path from:\n${result.stdout}`);
  return tarball;
}

const astroTarball = pack(repoRoot);
const stripeTarball = pack(resolve(repoRoot, 'packages/stripe'));

for (const [relativePath, contents] of readmeFiles) {
  const target = join(projectDir, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, relativePath === 'src/reserva-runtime.ts' ? runtimeModule : contents);
}
writeFileSync(join(projectDir, 'src/payments.ts'), simulatedPaymentsModule);
writeFileSync(join(projectDir, 'package.json'), `${JSON.stringify({
  name: 'reserva-quickstart-site',
  private: true,
  type: 'module',
  devDependencies: {
    '@astrojs/cloudflare': '^14.2.1',
    '@cloudflare/workers-types': '^5.20260813.1',
    astro: '^7.2.1',
    typescript: '^7.0.2',
    wrangler: '^4.122.0',
  },
}, null, 2)}\n`);
writeFileSync(join(projectDir, 'tsconfig.json'), `${JSON.stringify({
  extends: 'astro/tsconfigs/strict',
  compilerOptions: { types: ['@cloudflare/workers-types'] },
}, null, 2)}\n`);

console.log(`quickstart-test: assembled the README's quickstart in ${projectDir}`);
mustRun('install', 'bun', ['install'], projectDir);

// Until release day, bun resolves @reservajs/stripe's peer against the registry and 404s even
// though both tarballs land correctly, so the outcome is proven on disk instead of by exit code.
const add = run('bun', ['add', astroTarball, stripeTarball], projectDir);
for (const installed of ['@reservajs/astro', '@reservajs/stripe']) {
  if (!existsSync(join(projectDir, 'node_modules', installed, 'package.json'))) {
    fail(`[install] \`bun add\` did not install ${installed}:\n${add.stdout}\n${add.stderr}`);
  }
}

mustRun('types', 'bunx', ['wrangler', 'types'], projectDir);
mustRun('migrate', 'bunx', ['reserva-migrate', '--local'], projectDir);
mustRun('build', 'bunx', ['astro', 'build'], projectDir);

const preview = spawn(join(projectDir, 'node_modules/.bin/astro'), ['preview', '--host', HOST, '--port', String(PORT)], {
  cwd: projectDir,
  stdio: 'inherit',
  // Defeats Astro's "an agent is driving me" auto-backgrounding, the same reason
  // scripts/smoke-preview-test.ts sets it: this must stay the foreground process we terminate.
  env: { ...process.env, ASTRO_PREVIEW_BACKGROUND: '1' },
});
let exited = false;
preview.on('exit', () => { exited = true; });

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.text();
  if (response.status !== 200) fail(`GET ${path} returned ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  // Checkout answers 201 (it created a hold); quote answers 200.
  if (response.status !== 200 && response.status !== 201) fail(`POST ${path} returned ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}

try {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (exited) fail('astro preview exited before becoming ready');
    try {
      const response = await fetch(`${baseUrl}/api/booking/catalog?locale=en`);
      if (response.status < 500) break;
    } catch { /* connection refused while starting */ }
    if (Date.now() > deadline) fail('astro preview did not become ready within 60s');
    await delay(250);
  }

  const catalog = await getJson<{ services: Array<{ slug: string }> }>('/api/booking/catalog?locale=en');
  const service = catalog.services.find((entry) => entry.slug === 'alfama');
  if (!service) fail(`the catalog does not describe the quickstart's service: ${JSON.stringify(catalog)}`);

  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  const availability = await getJson<{ days: Array<{ slots: Array<{ start: string }> }> }>(
    `/api/booking/availability?service=alfama&quantity=2&from=${from}&to=${to}`,
  );
  const start = availability.days.flatMap((day) => day.slots).at(0)?.start;
  if (!start) fail('availability returned no bookable slot in the next 14 days');

  const quote = await postJson<{ priceMinor: number; currency: string }>('/api/booking/quote', {
    serviceSlug: 'alfama', quantity: 2, pickup: 'meeting_point', locale: 'en',
  });
  if (quote.priceMinor !== 4500 || quote.currency !== 'eur') fail(`unexpected quote ${JSON.stringify(quote)}`);

  const checkout = await postJson<{ checkoutUrl: string; bookingId: string; reference: string }>('/api/booking/checkout', {
    serviceSlug: 'alfama', start, quantity: 2, pickupType: 'meeting_point', locale: 'en',
  });

  // The session ref the simulated provider minted for this booking; a real deployment gets it back
  // from the payment provider's redirect instead.
  const sessionId = `sim_${checkout.bookingId}_${quote.priceMinor}`;
  const status = await getJson<{ status: string; booking: { reference: string } | null }>(
    `/api/booking/status?session_id=${encodeURIComponent(sessionId)}`,
  );
  if (status.status !== 'confirmed') fail(`booking did not confirm: ${JSON.stringify(status)}`);
  if (status.booking?.reference !== checkout.reference) fail(`status returned a different booking: ${JSON.stringify(status)}`);

  const confirmation = await fetch(`${baseUrl}/booking-confirmation?session_id=${encodeURIComponent(sessionId)}`);
  const html = await confirmation.text();
  if (confirmation.status !== 200) fail(`the confirmation page returned ${confirmation.status}`);
  if (!html.includes(checkout.reference)) fail('the confirmation page does not show the booking reference');

  console.log(`quickstart-test: booking ${checkout.reference} confirmed through the README's quickstart alone`);
} finally {
  preview.kill('SIGTERM');
  const stopDeadline = Date.now() + 5_000;
  while (!exited && Date.now() < stopDeadline) await delay(100);
  if (!exited) preview.kill('SIGKILL');
  if (!process.env.RESERVA_QUICKSTART_TEST_KEEP) rmSync(workDir, { recursive: true, force: true });
  else console.log(`quickstart-test: kept ${workDir}`);
}
