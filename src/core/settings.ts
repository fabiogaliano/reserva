import { ZodError } from 'astro/zod';
import { validateConfig, type ClientConfig } from './config.js';

// Operator-editable settings: the runtime-safe scalar dials of ClientConfig, stored as JSON and
// merged over the file config per request. A row equal to the file value is deleted, so a later
// config-file edit still takes effect for anything the operator never touched.

export type SettingValue = string | number | boolean | null;

export type SettingSection = 'policy' | 'capacity' | 'contact' | 'legal';

export type SettingKind =
  // `optional: true` lets an empty submission clear the field to null, merged as `undefined`.
  // `max` is set only where validateConfig enforces an upper bound, so parsing fails as fast as
  // the merge-then-validate backstop would.
  | { type: 'int'; min: number; max?: number; optional?: boolean }
  | { type: 'number'; min: number }
  | { type: 'boolean' }
  | { type: 'text'; optional?: boolean }
  | { type: 'email' }
  | { type: 'url' };

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
    // Floor mirrors validateConfig: below 35, a hold can expire while the payment session it
    // guards is still payable (oversell). Ceiling is the tightest session-open limit any shipped
    // payment adapter imposes, enforced here since an operator's submission never reaches
    // PaymentProvider.validateConfig.
    kind: { type: 'int', min: 35, max: 1440 },
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
    key: 'capacity.default', section: 'capacity', labelKey: 'setting.capacity',
    kind: { type: 'int', min: 0 },
    get: (config) => config.capacity.default,
    set: (config, value) => { config.capacity.default = value as number; },
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
    key: 'legal.termsUrl', section: 'legal', labelKey: 'setting.termsUrl',
    kind: { type: 'url' },
    get: (config) => config.legal.termsUrl,
    set: (config, value) => { config.legal.termsUrl = value as string; },
  },
];

export const settingSections: readonly SettingSection[] = ['policy', 'capacity', 'contact', 'legal'];

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
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < kind.min) return undefined;
      return kind.max === undefined || raw <= kind.max ? raw : undefined;
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
  }
}

// Merges stored overrides over the file config. Clones only the branches settings can touch — a
// deep clone is off the table because services carry the occupancyFor function.
// `onInvalidRow` is optional: the save path already validates fresh values and has nothing to
// report, while the load path uses it to attribute a warning to the row it's about to drop.
export function applySettingOverrides(
  config: ClientConfig,
  rows: Record<string, string>,
  onInvalidRow?: (key: string, reason: string) => void,
): ClientConfig {
  const keys = Object.keys(rows);
  if (keys.length === 0) return config;
  const next: ClientConfig = {
    ...config,
    capacity: { ...config.capacity },
    business: { ...config.business, contact: { ...config.business.contact } },
    booking: { ...config.booking, reschedule: { ...config.booking.reschedule } },
    legal: { ...config.legal },
  };
  for (const definition of settingDefinitions) {
    const stored = rows[definition.key];
    if (stored === undefined) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(stored);
    } catch {
      onInvalidRow?.(definition.key, 'stored value is not valid JSON');
      continue;
    }
    const value = decodeStoredValue(definition, raw);
    if (value !== undefined) definition.set(next, value);
    else onInvalidRow?.(definition.key, 'stored value fails its current bounds');
  }
  return next;
}

function zodIssues(error: unknown): Array<{ path: (string | number)[]; message: string }> {
  if (!(error instanceof ZodError)) throw error;
  return error.issues.map((issue) => ({ path: issue.path as (string | number)[], message: issue.message }));
}

export class SettingsMergeError extends Error {
  readonly issues: Array<{ path: (string | number)[]; message: string }>;

  constructor(issues: Array<{ path: (string | number)[]; message: string }>) {
    super(issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    this.name = 'SettingsMergeError';
    this.issues = issues;
  }
}

// Save-path backstop: a definition's kind bounds a field alone, but only validateConfig knows
// cross-field rules (e.g. locales.default must be in locales.supported). The section being saved
// is merged over every other stored override and the file config, then re-validated as a whole.
export function mergeAndValidateSettings(config: ClientConfig, rows: Record<string, string>): ClientConfig {
  const merged = applySettingOverrides(config, rows);
  try {
    return validateConfig(merged);
  } catch (error) {
    throw new SettingsMergeError(zodIssues(error));
  }
}

export interface SettingsLoadWarning {
  key: string;
  reason: string;
}

// Load-path counterpart of mergeAndValidateSettings, run on every request: a stored row saved
// under looser rules may now fail validation. Offending rows are dropped and reported via
// `onWarn`, falling back to the pristine file config if a failure can't be attributed to one key.
export function loadMergedConfig(
  config: ClientConfig,
  rows: Record<string, string>,
  onWarn?: (warning: SettingsLoadWarning) => void,
): ClientConfig {
  if (Object.keys(rows).length === 0) return config;
  let candidateRows = rows;
  for (let guard = 0; guard <= Object.keys(rows).length; guard += 1) {
    const merged = applySettingOverrides(config, candidateRows, (key, reason) => onWarn?.({ key, reason }));
    try {
      return validateConfig(merged);
    } catch (error) {
      const issues = zodIssues(error);
      const offendingKeys = [...new Set(issues.map((issue) => issue.path.join('.')))]
        .filter((key) => candidateRows[key] !== undefined);
      if (offendingKeys.length === 0) {
        onWarn?.({ key: '*', reason: `merged config failed validation: ${issues.map((issue) => issue.message).join('; ')}` });
        return config;
      }
      for (const key of offendingKeys) {
        onWarn?.({ key, reason: 'stored value produces an invalid merged config (validateConfig rejected the combination)' });
      }
      candidateRows = Object.fromEntries(Object.entries(candidateRows).filter(([key]) => !offendingKeys.includes(key)));
    }
  }
  return config;
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
  const raw = form.get(definition.key);
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') {
    if ((kind.type === 'int' || kind.type === 'text') && kind.optional) return null;
    throw new SettingParseError(`${definition.key}: a value is required`);
  }
  switch (kind.type) {
    case 'int': {
      const value = Number(text);
      const withinMax = kind.max === undefined || value <= kind.max;
      if (!Number.isInteger(value) || value < kind.min || !withinMax) {
        const range = kind.max === undefined ? `of at least ${kind.min}` : `between ${kind.min} and ${kind.max}`;
        throw new SettingParseError(`${definition.key}: must be an integer ${range}`);
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
