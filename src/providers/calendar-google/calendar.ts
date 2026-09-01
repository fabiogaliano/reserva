import type { Booking } from '../../core/booking';
import { meetingPointForBooking, pickupPresentationFor, type ClientConfig } from '../../core/config';
import type { CalendarProvider } from '../../core/events';
import type { CalEvent } from '../../core/occupancy';
import { ProviderFailure } from '../../provider-failure';
import { GoogleServiceAccountAuth, type GoogleAuthOptions } from './auth';

export interface GoogleCalendarAuth {
  getAccessToken(): Promise<string>;
}

export interface GoogleCalendarProviderOptions extends GoogleAuthOptions {
  calendarId: string;
  fetch?: typeof fetch;
  fetchImpl?: typeof fetch;
  auth?: GoogleCalendarAuth;
  apiBase?: string;
  apiBaseUrl?: string;
  calendarApiUrl?: string;
  timezone?: string;
}
interface GoogleEvent { id?: string; summary?: string; description?: string; start?: { dateTime?: string; date?: string; timeZone?: string }; end?: { dateTime?: string; date?: string; timeZone?: string }; attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string }>; extendedProperties?: { private?: Record<string, string> } }

const MAX_LIST_PAGES = 10;

function retryDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 25)));
}

function eventToCalEvent(event: GoogleEvent): CalEvent {
  const start = event.start?.dateTime ?? event.start?.date;
  const end = event.end?.dateTime ?? event.end?.date;
  if (!start || !end) throw new Error('Google Calendar event has no start or end');
  const allDay = Boolean(event.start?.date && !event.start?.dateTime);
  return {
    ...(event.id ? { id: event.id } : {}),
    ...(event.summary ? { summary: event.summary } : {}),
    ...(event.description ? { description: event.description } : {}),
    start,
    end,
    allDay,
    ...(event.extendedProperties ? { extendedProperties: event.extendedProperties } : {}),
    ...(event.extendedProperties?.private?.reservaBookingId ? { reservaBookingId: event.extendedProperties.private.reservaBookingId } : {}),
  };
}
function eventPayload(booking: Booking, config: ClientConfig | undefined, _timezone: string): GoogleEvent {
  const title = `${booking.reference} — ${booking.serviceSlug} — ${booking.quantity} quantity`;
  const service = config?.services[booking.serviceSlug];
  // Plan 023 (design decision 4): gated on the row's own data first — a location-less booking
  // gets no Pickup line at all, not a "Default meeting point" placeholder.
  const presentation = service ? pickupPresentationFor(service, booking) : null;
  // Plan 017 (design decision 4): same per-booking resolution as Brevo — a removed meeting point
  // id falls back to the booking's stored label snapshot with no maps link.
  const resolvedPoint = service && presentation ? meetingPointForBooking(service, booking.meetingPointId ?? null, booking.meetingPointLabel ?? null) : null;
  // Plan 018 (design decision 8): the two flags are independent gates, so an option declaring
  // BOTH (Maze's combined pickup+drop-off) shows the address on the Pickup line AND the maps URL
  // line.
  const requiresAddress = presentation?.requiresAddress ?? false;
  const usesMeetingPoint = presentation?.usesMeetingPoint ?? false;
  const pickupLine = requiresAddress
    ? booking.pickupAddress ?? (resolvedPoint?.label ?? 'Default meeting point')
    : resolvedPoint?.label ?? 'Default meeting point';
  const description = [
    `Booking: ${booking.reference}`,
    `Customer: ${booking.customerName ?? ''}`,
    `Email: ${booking.customerEmail ?? ''}`,
    `Phone: ${booking.customerPhone ?? ''}`,
    ...(presentation ? [`Pickup: ${pickupLine}`] : []),
    ...(usesMeetingPoint ? [resolvedPoint?.mapsUrl] : []),
  ].filter(Boolean).join('\n');
  const attendee = booking.customerEmail ? { email: booking.customerEmail, ...(booking.customerName ? { displayName: booking.customerName } : {}) } : undefined;
  return { id: booking.id.replaceAll('-', ''), summary: title, description, start: { dateTime: booking.startsAt }, end: { dateTime: booking.endsAt }, ...(attendee ? { attendees: [attendee] } : {}), extendedProperties: { private: { reservaBookingId: booking.id } } };
}

export class GoogleCalendarProvider implements CalendarProvider {
  readonly cacheKey: string;
  private readonly calendarId: string;
  private readonly auth: GoogleCalendarAuth;
  private readonly request: typeof fetch;
  private readonly apiBase: string;
  private readonly timezone: string;
  constructor(options: GoogleCalendarProviderOptions) {
    if (!options.calendarId) throw new Error('Google calendarId is required');
    this.calendarId = options.calendarId;
    this.cacheKey = options.calendarId;
    this.auth = options.auth ?? new GoogleServiceAccountAuth(options);
    // A bare global fetch stored as a method throws "Illegal invocation" in
    // workerd, which rebinds `this` to the instance; wrap it so `this` stays
    // globalThis (auth.ts uses defaultFetch for the same reason).
    this.request = options.fetchImpl ?? options.fetch ?? ((input, init) => fetch(input, init));
    this.apiBase = (options.apiBaseUrl ?? options.calendarApiUrl ?? options.apiBase ?? 'https://www.googleapis.com/calendar/v3').replace(/\/$/, '');
    this.timezone = options.timezone ?? 'UTC';
  }
  private url(path: string, params?: Record<string, string>): string {
    const url = `${this.apiBase}/calendars/${encodeURIComponent(this.calendarId)}/events${path}`;
    if (!params) return url;
    const query = new URLSearchParams(params);
    return `${url}?${query.toString()}`;
  }
  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    headers.set('authorization', `Bearer ${await this.auth.getAccessToken()}`);
    const response = await this.request(this.url(path), { ...init, headers });
    // Plan 016 (design decision 2): a structured ProviderFailure (status already in hand) so the
    // outbox attempt cap (src/confirmation.ts) can classify this without parsing message text.
    if (!response.ok) throw new ProviderFailure({ status: response.status, message: `Google Calendar request failed (${response.status})` });
    return response;
  }
  async listEvents(fromUtc: string, toUtc: string): Promise<CalEvent[]> {
    const token = await this.auth.getAccessToken();
    const events: CalEvent[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      if (pages >= MAX_LIST_PAGES) throw new Error(`Google Calendar pagination exceeded ${MAX_LIST_PAGES} pages`);
      const params: Record<string, string> = { singleEvents: 'true', timeMin: fromUtc, timeMax: toUtc };
      if (pageToken) params.pageToken = pageToken;
      let response: Response | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const candidate = await this.request(this.url('', params), { headers: { accept: 'application/json', authorization: `Bearer ${token}` } });
        if (candidate.ok || (candidate.status !== 429 && candidate.status < 500) || attempt === 1) {
          response = candidate;
          break;
        }
        await retryDelay();
      }
      if (!response?.ok) throw new ProviderFailure({ status: response?.status, message: `Google Calendar request failed (${response?.status ?? 'unknown'})` });
      pages += 1;
      const body = await response.json() as { items?: GoogleEvent[]; nextPageToken?: string };
      for (const event of body.items ?? []) {
        try {
          events.push(eventToCalEvent(event));
        } catch {
          // Calendar records without usable timed bounds cannot consume capacity capacity.
        }
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
    return events;
  }
  async createEvent(booking: Booking, config: ClientConfig): Promise<string> {
    const eventId = booking.id.replaceAll('-', '');
    const response = await this.request(this.url('?sendUpdates=all'), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${await this.auth.getAccessToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(eventPayload(booking, config, config.business.timezone || this.timezone)),
    });
    if (response.status === 409) return eventId;
    if (!response.ok) throw new ProviderFailure({ status: response.status, message: `Google Calendar request failed (${response.status})` });
    const body = await response.json() as GoogleEvent;
    if (!body.id) throw new Error('Google Calendar create response omitted event id');
    return body.id;
  }
  async patchEvent(eventId: string, booking: Booking, config?: ClientConfig): Promise<void> {
    await this.call(`/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(eventPayload(booking, config, config?.business.timezone ?? this.timezone)) });
  }
  async deleteEvent(eventId: string): Promise<void> {
    const response = await this.request(this.url(`/${encodeURIComponent(eventId)}?sendUpdates=all`), {
      method: 'DELETE',
      headers: { accept: 'application/json', authorization: `Bearer ${await this.auth.getAccessToken()}` },
    });
    if (!response.ok && response.status !== 404 && response.status !== 410) {
      throw new ProviderFailure({ status: response.status, message: `Google Calendar request failed (${response.status})` });
    }
  }
}
export const GoogleCalendar = GoogleCalendarProvider;
export const CalendarGoogleProvider = GoogleCalendarProvider;
export function createGoogleCalendarProvider(options: GoogleCalendarProviderOptions): GoogleCalendarProvider { return new GoogleCalendarProvider(options); }
export const mapGoogleCalendarEvent = eventToCalEvent;
export default GoogleCalendarProvider;
