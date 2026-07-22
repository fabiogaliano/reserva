import type { ClientConfig, PaymentMethod } from './config';

// Operator-editable settings: the runtime-safe scalar dials of ClientConfig, stored as JSON in the
// `settings` table and merged over the file config per request (see routes/route-context.ts).
// Anything structural (tours, locales), code (occupancyFor), or infrastructure (timezone, Access)
// deliberately stays file-only — those need a review and a deploy, not a form.
//
// A row is only written when the submitted value differs from the file config; a value equal to
// the config default deletes the row instead. That keeps "follow the config file" the resting
// state, so config edits in a later deploy still take effect for anything the operator never
// touched.

export type SettingValue = string | number | boolean | string[] | null;

export type SettingSection = 'policy' | 'contact' | 'payments' | 'legal';

export type SettingKind =
  // `optional: true` allows clearing the field: an empty submission stores an explicit null,
  // which merges as `undefined` (e.g. maxHoldsPerIp = unlimited, no WhatsApp number).
  | { type: 'int'; min: number; optional?: boolean }
  | { type: 'number'; min: number }
  | { type: 'boolean' }
  | { type: 'text'; optional?: boolean }
  | { type: 'email' }
  | { type: 'url' }
  | { type: 'methods' };

export interface SettingDefinition {
  key: string;
  section: SettingSection;
  // Message key (ui/messages.ts) for the form label; kept as a plain string to avoid a core → ui
  // import cycle.
  labelKey: string;
  // Message key for a subheading rendered above the first field of each run sharing the same
  // group; definitions in a section must keep grouped keys adjacent.
  groupKey?: string;
  kind: SettingKind;
  get(config: ClientConfig): SettingValue;
  set(config: ClientConfig, value: SettingValue): void;
}

const PAYMENT_METHODS: readonly PaymentMethod[] = ['card', 'mb_way'];

export const settingDefinitions: readonly SettingDefinition[] = [
  {
    key: 'booking.minNoticeHours', section: 'policy', labelKey: 'setting.minNoticeHours',
    groupKey: 'settingGroup.window',
    kind: { type: 'number', min: 0 },
    get: (config) => config.booking.minNoticeHours,
    set: (config, value) => { config.booking.minNoticeHours = value as number; },
  },
  {
    key: 'booking.maxHorizonDays', section: 'policy', labelKey: 'setting.maxHorizonDays',
    groupKey: 'settingGroup.window',
    kind: { type: 'int', min: 1 },
    get: (config) => config.booking.maxHorizonDays,
    set: (config, value) => { config.booking.maxHorizonDays = value as number; },
  },
  {
    key: 'booking.cancelCutoffHours', section: 'policy', labelKey: 'setting.cancelCutoffHours',
    groupKey: 'settingGroup.changes',
    kind: { type: 'number', min: 0 },
    get: (config) => config.booking.cancelCutoffHours,
    set: (config, value) => { config.booking.cancelCutoffHours = value as number; },
  },
  {
    key: 'booking.reschedule.enabled', section: 'policy', labelKey: 'setting.rescheduleEnabled',
    groupKey: 'settingGroup.changes',
    kind: { type: 'boolean' },
    get: (config) => config.booking.reschedule.enabled,
    set: (config, value) => { config.booking.reschedule.enabled = value as boolean; },
  },
  {
    key: 'booking.reschedule.cutoffHours', section: 'policy', labelKey: 'setting.rescheduleCutoffHours',
    groupKey: 'settingGroup.changes',
    kind: { type: 'number', min: 0 },
    get: (config) => config.booking.reschedule.cutoffHours,
    set: (config, value) => { config.booking.reschedule.cutoffHours = value as number; },
  },
  {
    key: 'booking.holdMinutes', section: 'policy', labelKey: 'setting.holdMinutes',
    groupKey: 'settingGroup.holds',
    kind: { type: 'int', min: 0 },
    get: (config) => config.booking.holdMinutes,
    set: (config, value) => { config.booking.holdMinutes = value as number; },
  },
  {
    key: 'booking.maxHoldsPerIp', section: 'policy', labelKey: 'setting.maxHoldsPerIp',
    groupKey: 'settingGroup.holds',
    kind: { type: 'int', min: 1, optional: true },
    get: (config) => config.booking.maxHoldsPerIp ?? null,
    set: (config, value) => {
      if (value === null) delete config.booking.maxHoldsPerIp;
      else config.booking.maxHoldsPerIp = value as number;
    },
  },
  {
    key: 'booking.limitedThreshold', section: 'policy', labelKey: 'setting.limitedThreshold',
    groupKey: 'settingGroup.holds',
    kind: { type: 'int', min: 0 },
    get: (config) => config.booking.limitedThreshold,
    set: (config, value) => { config.booking.limitedThreshold = value as number; },
  },
  {
    key: 'business.name', section: 'contact', labelKey: 'setting.businessName',
    kind: { type: 'text' },
    get: (config) => config.business.name,
    set: (config, value) => { config.business.name = value as string; },
  },
  {
    key: 'business.contact.email', section: 'contact', labelKey: 'setting.contactEmail',
    kind: { type: 'email' },
    get: (config) => config.business.contact.email,
    set: (config, value) => { config.business.contact.email = value as string; },
  },
  {
    key: 'business.contact.phone', section: 'contact', labelKey: 'setting.contactPhone',
    kind: { type: 'text' },
    get: (config) => config.business.contact.phone,
    set: (config, value) => { config.business.contact.phone = value as string; },
  },
  {
    key: 'business.contact.whatsapp', section: 'contact', labelKey: 'setting.contactWhatsapp',
    kind: { type: 'text', optional: true },
    get: (config) => config.business.contact.whatsapp ?? null,
    set: (config, value) => {
      if (value === null) delete config.business.contact.whatsapp;
      else config.business.contact.whatsapp = value as string;
    },
  },
  {
    key: 'payments.methods', section: 'payments', labelKey: 'setting.paymentMethods',
    kind: { type: 'methods' },
    get: (config) => [...config.payments.methods],
    set: (config, value) => { config.payments.methods = value as PaymentMethod[]; },
  },
  {
    key: 'legal.termsUrl', section: 'legal', labelKey: 'setting.termsUrl',
    kind: { type: 'url' },
    get: (config) => config.legal.termsUrl,
    set: (config, value) => { config.legal.termsUrl = value as string; },
  },
];

export const settingSections: readonly SettingSection[] = ['policy', 'contact', 'payments', 'legal'];

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

// Validates a decoded stored value against its definition. Returns undefined for anything invalid
// so a stale or hand-edited row degrades to "follow the config" instead of corrupting the runtime
// config every request.
function decodeStoredValue(definition: SettingDefinition, raw: unknown): SettingValue | undefined {
  const kind = definition.kind;
  switch (kind.type) {
    case 'int':
      if (raw === null) return kind.optional ? null : undefined;
      return typeof raw === 'number' && Number.isInteger(raw) && raw >= kind.min ? raw : undefined;
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) && raw >= kind.min ? raw : undefined;
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined;
    case 'text':
      if (raw === null) return kind.optional ? null : undefined;
      return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined;
    case 'email':
      return typeof raw === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : undefined;
    case 'url':
      return typeof raw === 'string' && isValidHttpUrl(raw) ? raw : undefined;
    case 'methods': {
      if (!Array.isArray(raw) || raw.length === 0) return undefined;
      const methods = raw.filter((entry): entry is PaymentMethod => PAYMENT_METHODS.includes(entry as PaymentMethod));
      return methods.length === raw.length ? [...new Set(methods)] : undefined;
    }
  }
}

// Merges stored overrides (key -> JSON string, as returned by repo.listSettings) over the file
// config. Clones only the branches settings can touch — a deep clone is off the table because
// tours carry the occupancyFor function.
export function applySettingOverrides(config: ClientConfig, rows: Record<string, string>): ClientConfig {
  const keys = Object.keys(rows);
  if (keys.length === 0) return config;
  const next: ClientConfig = {
    ...config,
    business: { ...config.business, contact: { ...config.business.contact } },
    booking: { ...config.booking, reschedule: { ...config.booking.reschedule } },
    payments: { ...config.payments, methods: [...config.payments.methods] },
    legal: { ...config.legal },
  };
  for (const definition of settingDefinitions) {
    const stored = rows[definition.key];
    if (stored === undefined) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(stored);
    } catch {
      continue;
    }
    const value = decodeStoredValue(definition, raw);
    if (value !== undefined) definition.set(next, value);
  }
  return next;
}

export class SettingParseError extends Error {}

interface FormLike {
  get(name: string): unknown;
  getAll(name: string): unknown[];
}

// Parses one setting from a submitted admin form (field name = setting key). Throws
// SettingParseError with an operator-readable message; the handler maps it to a 400.
export function parseSettingForm(definition: SettingDefinition, form: FormLike): SettingValue {
  const kind = definition.kind;
  if (kind.type === 'boolean') return form.get(definition.key) !== null;
  if (kind.type === 'methods') {
    const raw = form.getAll(definition.key).filter((entry): entry is string => typeof entry === 'string');
    const methods = [...new Set(raw)].filter((entry): entry is PaymentMethod => PAYMENT_METHODS.includes(entry as PaymentMethod));
    if (methods.length === 0) throw new SettingParseError(`${definition.key}: at least one payment method is required`);
    return methods;
  }
  const raw = form.get(definition.key);
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') {
    if ((kind.type === 'int' || kind.type === 'text') && kind.optional) return null;
    throw new SettingParseError(`${definition.key}: a value is required`);
  }
  switch (kind.type) {
    case 'int': {
      const value = Number(text);
      if (!Number.isInteger(value) || value < kind.min) {
        throw new SettingParseError(`${definition.key}: must be an integer of at least ${kind.min}`);
      }
      return value;
    }
    case 'number': {
      const value = Number(text);
      if (!Number.isFinite(value) || value < kind.min) {
        throw new SettingParseError(`${definition.key}: must be a number of at least ${kind.min}`);
      }
      return value;
    }
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw new SettingParseError(`${definition.key}: must be a valid email address`);
      return text;
    case 'url':
      if (!isValidHttpUrl(text)) throw new SettingParseError(`${definition.key}: must be a valid http(s) URL`);
      return text;
    case 'text':
      return text;
  }
}

export function settingValuesEqual(a: SettingValue, b: SettingValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function serializeSettingValue(value: SettingValue): string {
  return JSON.stringify(value);
}
