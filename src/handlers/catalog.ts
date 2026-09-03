import type {
  CatalogLocation,
  CatalogMetadataField,
  CatalogResponse,
  CatalogService,
} from '../core/api.js';
import {
  resolveMetadataFieldLabel,
  type ResolvedClientConfig,
  type PickupOption,
  type ResolvedServiceConfig,
} from '../core/config.js';
import { resolveLocale } from '../core/locale.js';
import type { ReservaContext } from '../context.js';
import { HttpError, json } from '../http.js';
import { resolveMessages, type ReservaMessages } from '../ui/messages.js';
import { run } from './shared.js';

// Customer-facing catalog contract. Must never expose turnaroundMin, the raw schedule, pricing
// rules, capacity, or any occupancy number — adding a field here declares it customer-facing.

// `label`/`hint` stay optional, falling back to the message catalog for `default`/`custom` ids,
// so every consumer resolves the same copy from one place.
function pickupCopy(option: PickupOption, messages: ReservaMessages): { label: string; hint: string | null } {
  if (option.id === 'default') {
    return { label: option.label ?? messages['widget.pickupDefault'], hint: option.hint ?? messages['widget.pickupDefaultHint'] };
  }
  if (option.id === 'custom') {
    return { label: option.label ?? messages['widget.pickupCustom'], hint: option.hint ?? messages['widget.pickupCustomHint'] };
  }
  return { label: option.label ?? option.id, hint: option.hint ?? null };
}

function catalogLocation(service: ResolvedServiceConfig, messages: ReservaMessages): CatalogLocation | null {
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

function catalogMetadataFields(service: ResolvedServiceConfig, locale: string, defaultLocale: string): CatalogMetadataField[] {
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

export function catalogPayload(config: ResolvedClientConfig, locale: string, messages: ReservaMessages): CatalogResponse {
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
    // `context.config` is the MERGED config: operator settings edits are already applied, so an
    // edited maxHorizonDays or capacity policy is reflected here, not the pristine file config.
    const payload = catalogPayload(context.config, locale, resolveMessages(context.config, locale));
    // Cacheable via HTTP only: the projection is cheap, so there's no library-side cache entry to
    // invalidate, and the short TTL bounds staleness after a settings edit.
    return json(payload, 200, { 'cache-control': 'public, max-age=60' });
  });
}
