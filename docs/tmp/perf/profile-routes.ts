// CPU cost of the heavy routes against a site-sized deployment (6 tours, 09:00-18:00 every 30 min,
// ~80 bookings), cold (first call, as in a fresh Worker isolate) and warm.
// Run: bun scripts/profile-routes.ts   (add --cpu-prof for a profile)
import type { D1Database } from '@cloudflare/workers-types';
import { createReservaContext } from '../../../src/context';
import type { Booking } from '../../../src/core/booking';
import type { ResolvedClientConfig, ResolvedServiceConfig } from '../../../src/core/config';
import { handleAdminGet, handleAvailability } from '../../../src/handlers';
import { booking, config, service } from '../../../tests/fixtures';
import { fakeRepository, providers } from '../../../tests/fakes';

const now = new Date('2026-09-29T03:00:00.000Z');
const durations = { alfama: 90, belem: 120, historic: 120, heritage: 180, grand: 240, test: 60 };
const partner = {
  key: 'partner', label: { en: 'Partner', 'pt-PT': 'Parceiro' }, type: 'select' as const, visibility: 'operator' as const, adminBadge: true,
  adminOptionLink: 'https://example.test/?ref={value}', options: [{ value: 'lovelystay', label: 'LovelyStay' }],
};
const services: Record<string, ResolvedServiceConfig> = Object.fromEntries(Object.entries(durations).map(([slug, durationMin]) => {
  const last = 18 * 60 - durationMin;
  const lastStart = `${String(Math.floor(last / 60)).padStart(2, '0')}:${String(last % 60).padStart(2, '0')}`;
  return [slug, { ...service, title: slug, durationMin, schedule: [{ days: [0, 1, 2, 3, 4, 5, 6], firstStart: '09:00', lastStart, intervalMin: 30 }], metadataFields: [partner] }];
}));
const siteConfig: ResolvedClientConfig = {
  ...config,
  capacity: { default: 4 },
  admin: { ...config.admin, locale: 'pt-PT' },
  services,
  booking: { ...config.booking, minNoticeHours: 1, maxHorizonDays: 500 },
};

const slugs = Object.keys(durations);
const rows: Booking[] = Array.from({ length: 80 }, (_, i) => {
  const start = new Date(now.getTime() + (i - 40) * 86_400_000 * 0.75);
  start.setUTCHours(9 + (i % 7), 0, 0, 0);
  const slug = slugs[i % slugs.length]!;
  return booking({
    id: `b-${i}`, reference: `LVT-2026-${String(i).padStart(3, '0')}`, serviceSlug: slug, status: i % 9 === 0 ? 'cancelled' : 'confirmed',
    startsAt: start.toISOString(), endsAt: new Date(start.getTime() + durations[slug as keyof typeof durations] * 60_000).toISOString(),
    operatorToken: `op-${i}`, cancelToken: `cancel-${i}`, metadata: i % 4 === 0 ? { partner: 'lovelystay' } : {},
  });
});

const context = createReservaContext({
  config: siteConfig, db: {} as D1Database, repo: fakeRepository(rows), clock: () => now,
  adminAuth: async () => ({ subject: '' }), providers: providers(),
  secrets: async (name: string) => (name === 'RESERVA_CSRF_SECRET' ? 'x'.repeat(48) : undefined),
  logger: { warn: () => undefined, error: () => undefined, info: () => undefined },
});

const cpuMs = () => process.cpuUsage().user / 1000 + process.cpuUsage().system / 1000;
async function measure(label: string, call: () => Promise<Response>) {
  let t = cpuMs();
  const first = await call();
  await first.text();
  const cold = cpuMs() - t;
  t = cpuMs();
  for (let i = 0; i < 5; i++) await (await call()).text();
  console.log(`${label.padEnd(44)} status ${first.status}  first ${cold.toFixed(1).padStart(7)} ms  warm ${((cpuMs() - t) / 5).toFixed(1).padStart(7)} ms`);
}

const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
const availability = (days: number) => () => handleAvailability(new Request(`https://example.test/api/booking/availability?serviceSlug=historic&quantity=4&from=${day(0)}&to=${day(days - 1)}`), context);
const admin = (query: string) => () => handleAdminGet(new Request(`https://example.test/booking/admin${query}`), context);

const only = process.argv[2];
const cases: Array<[string, () => Promise<Response>]> = [
  ['admin ?tab=upcoming', admin('?tab=upcoming')],
  ['admin ?tab=availability', admin('?tab=availability')],
  ['admin ?tab=tags', admin('?tab=tags')],
  ['availability 1 day', availability(1)],
  ['availability 30 days', availability(30)],
  ['availability 90 days', availability(90)],
  ['availability 500 days', availability(500)],
];
for (const [label, call] of cases) if (!only || label.includes(only)) await measure(label, call);
