// Plan 017 (design decision 5): renders the real compiled BookingWidget.astro (see
// vitest.component.config.ts / instance-ids.test.ts for why this needs the Astro Vite pipeline
// instead of tests/ui-booking-widget.test.ts's source-text assertions) to prove the actual DOM
// shape the meetingPoints prop produces — the done criterion is that 0-1 points render *nothing
// new*, so this checks markup equality against the pre-existing baseline, not just presence.
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- resolved by vitest.component.config.ts's Astro Vite pipeline, not by tsc.
import BookingWidget from '../../src/components/BookingWidget.astro';

const propsWithoutLocale = { tourSlug: 'oldTown', availabilityFrom: '2026-01-01', availabilityTo: '2026-01-02' };
const baseProps = { ...propsWithoutLocale, locale: 'en' };

async function render(props: Record<string, unknown>): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(BookingWidget, { props });
}

// dateLabelId is a fresh crypto.randomUUID() every render (Plan 014 item A — two instances must
// never share one), so a byte-identical-markup comparison across two separate render() calls must
// normalize it out first, or it fails on that alone regardless of the meetingPoints prop.
function stripInstanceId(html: string): string {
  return html.replace(/bkw-date-label-[0-9a-f-]+/g, 'bkw-date-label-<id>');
}

describe('BookingWidget.astro meetingPoints prop (Plan 017 design decision 5)', () => {
  it('renders European Portuguese when no locale is supplied', async () => {
    const html = await render(propsWithoutLocale);
    expect(html).toContain('aria-label="Reservar este tour"');
    expect(html).toContain('name="locale" value="pt-PT"');
  });

  it('with no meetingPoints prop, renders no meeting-point markup at all', async () => {
    const html = await render(baseProps);
    expect(html).not.toContain('data-bookkit-meeting-points');
    expect(html).not.toContain('name="meetingPointId"');
  });

  it('with exactly one point, renders byte-identical markup to omitting the prop entirely', async () => {
    const withoutProp = await render(baseProps);
    const withOnePoint = await render({ ...baseProps, meetingPoints: [{ id: 'default', label: 'Main square fountain' }] });
    expect(stripInstanceId(withOnePoint)).toBe(stripInstanceId(withoutProp));
  });

  it('with two points, renders a radio group named meetingPointId with the first option checked', async () => {
    const html = await render({
      ...baseProps,
      meetingPoints: [
        { id: 'fountain', label: 'Main square fountain' },
        { id: 'station', label: 'Riverside dock' },
      ],
    });
    expect(html).toContain('data-bookkit-meeting-points');
    expect(html).toContain('Choose a meeting point');
    const matches = [...html.matchAll(/<input type="radio" name="meetingPointId" value="([^"]+)"[^>]*>/g)];
    expect(matches.map((m) => m[1])).toEqual(['fountain', 'station']);
    // First option checked, second not — mirrors the pickupType group's own default.
    expect(matches[0]?.[0]).toContain('checked');
    expect(matches[1]?.[0]).not.toContain('checked');
    expect(html).toContain('Main square fountain');
    expect(html).toContain('Riverside dock');
  });

  it('with three points, still renders exactly one group with all three options', async () => {
    const html = await render({
      ...baseProps,
      meetingPoints: [
        { id: 'a', label: 'Point A' },
        { id: 'b', label: 'Point B' },
        { id: 'c', label: 'Point C' },
      ],
    });
    const matches = [...html.matchAll(/name="meetingPointId"/g)];
    expect(matches).toHaveLength(3);
  });
});
