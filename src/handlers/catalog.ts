import type {
  CatalogLocation,
  CatalogMetadataField,
  CatalogPricing,
  CatalogResponse,
  CatalogService,
} from '../core/api.js';
import {
  maxQuantityFor,
  resolveLocalizedText,
  resolveServiceTitle,
  type ResolvedClientConfig,
  type PickupOption,
  type ResolvedServiceConfig,
} from '../core/config.js';
import { resolveLocale } from '../core/locale.js';
import { lowestPriceMinor } from '../core/pricing.js';
import type { ReservaContext } from '../context.js';
import { HttpError, json } from '../http.js';
import { resolveMessages, type ReservaMessages } from '../ui/messages.js';
import { run } from './shared.js';

// Customer-facing catalog contract. Must never expose turnaroundMin, the raw schedule, capacity,
// or any occupancy number — adding a field here declares it customer-facing.

interface Locales { locale: string; defaultLocale: string }

// Ids are opaque: a declared option is named by its own required label, and the only option without
// one is the implied meeting-point option, which the message catalog names in the request locale.
function pickupCopy(option: PickupOption, locales: Locales, messages: ReservaMessages): { label: string; hint: string | null } {
  return {
    label: option.label ? resolveLocalizedText(option.label, locales.locale, locales.defaultLocale) : messages['pickup.meetingPoint'],
    hint: option.hint ? resolveLocalizedText(option.hint, locales.locale, locales.defaultLocale) : null,
  };
}

function catalogLocation(service: ResolvedServiceConfig, locales: Locales, messages: ReservaMessages): CatalogLocation | null {
  if (!service.location) return null;
  return {
    // Empty (not absent) for a location-ful service that collects only a custom address.
    meetingPoints: (service.location.meetingPoints ?? []).map((point) => ({
      id: point.id,
      label: resolveLocalizedText(point.label, locales.locale, locales.defaultLocale),
      mapsUrl: point.mapsUrl,
      meta: point.meta ?? {},
    })),
    pickupOptions: service.location.pickupOptions.map((option) => ({
      id: option.id,
      ...pickupCopy(option, locales, messages),
      requiresAddress: option.requiresAddress,
      usesMeetingPoint: option.usesMeetingPoint,
    })),
  };
}

function catalogMetadataFields(service: ResolvedServiceConfig, locale: string, defaultLocale: string): CatalogMetadataField[] {
  return (service.metadataFields ?? []).map((field) => ({
    key: field.key,
    label: resolveLocalizedText(field.label, locale, defaultLocale),
    type: field.type,
    options: (field.options ?? []).map((option) => ({
      value: option.value,
      label: resolveLocalizedText(option.label, locale, defaultLocale),
    })),
    required: field.required ?? false,
    maxLength: field.maxLength ?? null,
  }));
}

// Projected field by field rather than spread, so a future private column on a pricing rule does
// not become customer-facing by accident. A formula's `inherited` flags are config provenance, not
// a price, and stay out; `seatsPerUnit` is the one occupancy number a formula price depends on.
function catalogPricing(service: ResolvedServiceConfig): CatalogPricing {
  if (Array.isArray(service.pricing)) {
    return service.pricing.map((rule) => ({
      maxQuantity: rule.maxQuantity,
      pickup: rule.pickup ?? null,
      priceMinor: rule.priceMinor,
    }));
  }
  const formula = service.pricing;
  return {
    baseMinor: formula.baseMinor,
    surcharges: { ...formula.surcharges },
    maxUnits: formula.maxUnits,
    surchargeScope: formula.surchargeScope,
    seatsPerUnit: formula.seatsPerUnit,
  };
}

export function catalogPayload(config: ResolvedClientConfig, locale: string, messages: ReservaMessages): CatalogResponse {
  const locales: Locales = { locale, defaultLocale: config.locales.default };
  const services: CatalogService[] = Object.entries(config.services).map(([slug, service]) => {
    const pricing = catalogPricing(service);
    return {
      slug,
      title: resolveServiceTitle(config, slug, locale),
      durationMin: service.durationMin,
      location: catalogLocation(service, locales, messages),
      metadataFields: catalogMetadataFields(service, locale, config.locales.default),
      pricing,
      maxQuantity: maxQuantityFor(service),
      // Pricing always covers quantity 1 (rows by schema `min(1)`, a formula by construction), so
      // this is never Infinity.
      fromPriceMinor: lowestPriceMinor(service),
      // Always present, like every other catalog field: a consumer reads `meta.image` without
      // first proving the key exists.
      meta: service.meta ?? {},
    };
  });
  return {
    services,
    locales: { supported: config.locales.supported, default: config.locales.default },
    currency: config.business.currency,
    maxHorizonDays: config.booking.maxHorizonDays,
    policy: {
      cancelCutoffHours: config.booking.cancelCutoffHours,
      reschedule: { enabled: config.booking.reschedule.enabled, cutoffHours: config.booking.reschedule.cutoffHours },
    },
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
