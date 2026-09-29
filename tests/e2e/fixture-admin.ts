import type { Page } from '@playwright/test';
import type { D1Database } from '@cloudflare/workers-types';
import { createReservaContext } from '../../src/context';
import type { Booking } from '../../src/core/booking';
import type { ResolvedClientConfig } from '../../src/core/config';
import { adminPage, type AdminTab } from '../../src/ui/pages/admin-page';
import { config as fixtureConfig } from '../fixtures';
import { fakeRepository, providers } from '../fakes';

// Some admin states cannot be reached on the smoke site's shared database without spending the
// scarce slots other specs book into (or at all: it declares no badge field and takes no refunds).
// The dashboard is then rendered from fixtures by the real renderer — the handler's module graph
// needs the build-time virtual config — and served in place of the route, while the enhancer is
// still the running server's own asset.
export async function openFixtureAdminPage(page: Page, baseURL: string | undefined, options: {
  rows: Booking[];
  activeTab: AdminTab;
  editDate: string;
  config?: ResolvedClientConfig;
}): Promise<void> {
  const { rows, activeTab, editDate } = options;
  const context = createReservaContext({
    config: options.config ?? fixtureConfig, db: {} as D1Database, repo: fakeRepository(rows),
    clock: () => new Date('2026-06-14T08:00:00.000Z'), adminAuth: async () => ({ subject: '' }), providers: providers(),
  });
  const load = new Map<string, { peak: number; bookings: number }>();
  for (const row of rows) {
    const date = row.startsAt.slice(0, 10);
    const day = load.get(date) ?? { peak: 0, bookings: 0 };
    load.set(date, { peak: day.peak + row.quantity, bookings: day.bookings + 1 });
  }
  const html = adminPage(context, {
    list: { rows, total: rows.length, page: 1, pageSize: 50, searchScanLimit: null, statusCounts: null },
    filters: { when: 'upcoming', q: '', status: 'active', page: 1 },
    calendar: {
      fromDate: '2026-06-14', toDate: '2026-06-30', windowFrom: '2026-06-14', prevMonth: null, nextMonth: null,
      overrides: [], capacityDefaults: [], load,
      dayBookings: rows, detailBefore: null, editDayBookings: rows.filter((row) => row.startsAt.startsWith(editDate)),
    },
    editDate, saved: '', error: null, csrfToken: undefined, incidentsHtml: '', hasIncidents: false,
    attention: { count: 0, actionRequired: false, first: null },
    glance: { nextToday: null, firstTomorrow: null, holds: 0, holdsExpireFirst: null },
    activeTab, tagOverview: [],
  });
  await page.route('**/booking/admin?**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(`${baseURL}/booking/admin?tab=${activeTab}&date=${editDate}`);
}
