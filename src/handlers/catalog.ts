import type {
  CatalogLocation,
  CatalogMetadataField,
  CatalogResponse,
  CatalogService,
} from '../core/api';
import {
  resolveMetadataFieldLabel,
  type ClientConfig,
  type PickupOption,
  type ServiceConfig,
} from '../core/config';
import { resolveLocale } from '../core/locale';
import type { ReservaContext } from '../context';
import { HttpError, json } from '../http';
import { resolveMessages, type ReservaMessages } from '../ui/messages';
import { run } from './shared';

// Plan 027 (design decision 6): the rendering contract — everything a consumer needs to build a
// booking flow before a date is chosen, read from the deployment instead of duplicated in its own
// code. This is what lets a widget delete its hardcoded service and pickup-option tables the same
// way the quote endpoint lets it delete its price math.
//
// What this must NEVER expose (the plan's STOP condition): turnaroundMin, the raw schedule, pricing
// rules, capacity, occupancyFor, or any occupancy number. Exact money is the quote endpoint's
// answer; bookable times and scarcity are availability's, gated by limitedThreshold. Adding a field
// here is a deliberate act: it means declaring it customer-facing.

// Plan 018 kept `label`/`hint` optional on a declared pickup option, falling back to the message
// catalog for the historical `default`/`custom` ids. That fallback chain lived in the widget; it
// belongs here, so every consumer resolves the same copy from one place.
function pickupCopy(option: PickupOption, messages: ReservaMessages): { label: string; hint: string | null } {
  if (option.id === 'default') {
    return { label: option.label ?? messages['widget.pickupDefault'], hint: option.hint ?? messages['widget.pickupDefaultHint'] };
  }
  if (option.id === 'custom') {
    return { label: option.label ?? messages['widget.pickupCustom'], hint: option.hint ?? messages['widget.pickupCustomHint'] };
  }
  return { label: option.label ?? option.id, hint: option.hint ?? null };
}

function catalogLocation(service: ServiceConfig, messages: ReservaMessages): CatalogLocation | null {
  if (!service.location) return null;
  return {
    // Empty (not absent) for a location-ful service that collects only a custom address.
    meetingPoints: (service.location.meetingPoints ?? []).map((point) => ({
      id: point.id, label: point.label, mapsUrl: point.mapsUrl,
    })),
    pickupOptions: service.location.pickupOptions.map((option) => ({
      id: option.id,
      ...pickupCopy(option, messages),
      requiresAddress: option.requiresAddress,
      usesMeetingPoint: option.usesMeetingPoint,
    })),
  };
}

function catalogMetadataFields(service: ServiceConfig, locale: string, defaultLocale: string): CatalogMetadataField[] {
  return (service.metadataFields ?? []).map((field) => ({
    key: field.key,
    label: resolveMetadataFieldLabel(field.label, locale, defaultLocale),
    type: field.type,
    options: (field.options ?? []).map((option) => ({
      value: option.value,
      label: resolveMetadataFieldLabel(option.label, locale, defaultLocale),
    })),
    required: field.required ?? false,
    maxLength: field.maxLength ?? null,
  }));
}

export function catalogPayload(config: ClientConfig, locale: string, messages: ReservaMessages): CatalogResponse {
  const services: CatalogService[] = Object.entries(config.services).map(([slug, service]) => ({
    slug,
    // A service with no declared title is identified by its slug — the same fallback emails use.
    title: service.title ?? slug,
    durationMin: service.durationMin,
    location: catalogLocation(service, messages),
    metadataFields: catalogMetadataFields(service, locale, config.locales.default),
  }));
  return {
    services,
    locales: { supported: config.locales.supported, default: config.locales.default },
    currency: config.business.currency,
    maxHorizonDays: config.booking.maxHorizonDays,
  };
}

export function handleCatalog(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const locale = resolveLocale(context.config.locales, new URL(request.url).searchParams.get('locale'));
    // `context.config` is the MERGED config — operator settings edits (createRouteContext,
    // src/routes/route-context.ts) are already applied, so an edited maxHorizonDays or capacity
    // policy is reflected here rather than serving the pristine file config forever.
    const payload = catalogPayload(context.config, locale, resolveMessages(context.config, locale));
    // "Cacheable" is HTTP-only by design: the projection is cheap, so there is no library-side cache
    // entry to invalidate, and the short TTL bounds staleness after a settings edit.
    return json(payload, 200, { 'cache-control': 'public, max-age=60' });
  });
}
