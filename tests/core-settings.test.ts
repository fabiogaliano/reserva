import { describe, expect, it } from 'vitest';
import type { ResolvedClientConfig } from '../src/core/config';
import {
  SettingParseError,
  SettingsMergeError,
  applySettingOverrides,
  loadMergedConfig,
  mergeAndValidateSettings,
  parseSettingForm,
  settingDefinitions,
  type SettingsLoadWarning,
} from '../src/core/settings';
import { config } from './fixtures';

function definition(key: string) {
  const found = settingDefinitions.find((entry) => entry.key === key);
  if (!found) throw new Error(`unknown setting ${key}`);
  return found;
}

function form(fields: Record<string, string | string[]>) {
  return {
    get: (name: string) => {
      const value = fields[name];
      if (value === undefined) return null;
      return Array.isArray(value) ? value[0] ?? null : value;
    },
    getAll: (name: string) => {
      const value = fields[name];
      if (value === undefined) return [];
      return Array.isArray(value) ? value : [value];
    },
  };
}

describe('core settings', () => {
  it('applies valid overrides without touching the base config object', () => {
    const merged = applySettingOverrides(config, {
      'booking.minNoticeHours': '2',
      'booking.reschedule.enabled': 'false',
      'capacity.default': '4',
      'business.contact.email': JSON.stringify('new@example.test'),
    });
    expect(merged.booking.minNoticeHours).toBe(2);
    expect(merged.booking.reschedule.enabled).toBe(false);
    expect(merged.capacity.default).toBe(4);
    expect(merged.business.contact.email).toBe('new@example.test');
    // Untouched values still come from the file config, and the original is not mutated.
    expect(merged.booking.maxHorizonDays).toBe(config.booking.maxHorizonDays);
    expect(config.booking.minNoticeHours).toBe(24);
    expect(config.capacity.default).toBe(2);
  });

  it('ignores unknown keys, malformed JSON, and values that fail validation', () => {
    const merged = applySettingOverrides(config, {
      'no.such.setting': '5',
      'booking.minNoticeHours': 'not-json{',
      'booking.maxHorizonDays': '"twelve"',
      'booking.holdMinutes': '-3',
      // payments.methods was retired to the Stripe provider's own options, so a row left behind
      // by an older deployment is just an unknown key now.
      'payments.methods': JSON.stringify(['bitcoin']),
      'legal.termsUrl': JSON.stringify('javascript:alert(1)'),
      'booking.limitedThreshold': '1',
    });
    expect(merged.booking.minNoticeHours).toBe(config.booking.minNoticeHours);
    expect(merged.booking.maxHorizonDays).toBe(config.booking.maxHorizonDays);
    expect(merged.booking.holdMinutes).toBe(config.booking.holdMinutes);
    expect(merged).not.toHaveProperty('payments');
    expect(merged.legal.termsUrl).toBe(config.legal.termsUrl);
    expect(merged.booking.limitedThreshold).toBe(1);
  });

  it('returns the same config instance when there are no overrides', () => {
    expect(applySettingOverrides(config, {})).toBe(config);
  });

  it('an explicit null unsets optional settings', () => {
    const withLimit = { ...config, booking: { ...config.booking, maxHoldsPerIp: 5 } };
    const merged = applySettingOverrides(withLimit, { 'booking.maxHoldsPerIp': 'null' });
    expect(merged.booking.maxHoldsPerIp).toBeUndefined();
  });

  it('parses form values per kind: numbers, checkboxes, and optional empties', () => {
    expect(parseSettingForm(definition('booking.minNoticeHours'), form({ 'booking.minNoticeHours': '1.5' }))).toBe(1.5);
    expect(parseSettingForm(definition('booking.maxHorizonDays'), form({ 'booking.maxHorizonDays': '45' }))).toBe(45);
    expect(parseSettingForm(definition('capacity.default'), form({ 'capacity.default': '5' }))).toBe(5);
    expect(parseSettingForm(definition('booking.reschedule.enabled'), form({ 'booking.reschedule.enabled': 'on' }))).toBe(true);
    expect(parseSettingForm(definition('booking.reschedule.enabled'), form({}))).toBe(false);
    expect(parseSettingForm(definition('booking.maxHoldsPerIp'), form({ 'booking.maxHoldsPerIp': '' }))).toBeNull();
    expect(parseSettingForm(definition('business.contact.whatsapp'), form({}))).toBeNull();
  });

  it('rejects invalid form values with SettingParseError', () => {
    expect(() => parseSettingForm(definition('booking.maxHorizonDays'), form({ 'booking.maxHorizonDays': '2.5' }))).toThrow(SettingParseError);
    expect(() => parseSettingForm(definition('booking.maxHorizonDays'), form({ 'booking.maxHorizonDays': '0' }))).toThrow(SettingParseError);
    expect(() => parseSettingForm(definition('capacity.default'), form({ 'capacity.default': '-1' }))).toThrow(SettingParseError);
    expect(() => parseSettingForm(definition('capacity.default'), form({ 'capacity.default': '2.5' }))).toThrow(SettingParseError);
    expect(() => parseSettingForm(definition('business.name'), form({ 'business.name': '   ' }))).toThrow(SettingParseError);
    expect(() => parseSettingForm(definition('business.contact.email'), form({ 'business.contact.email': 'not-an-email' }))).toThrow(SettingParseError);
    expect(() => parseSettingForm(definition('legal.termsUrl'), form({ 'legal.termsUrl': 'ftp://example.test' }))).toThrow(SettingParseError);
  });

  it('rejects holdMinutes form values outside [35, 1440] and accepts the boundary values', () => {
    for (const bad of ['0', '34', '1441']) {
      expect(() => parseSettingForm(definition('booking.holdMinutes'), form({ 'booking.holdMinutes': bad }))).toThrow(SettingParseError);
    }
    for (const good of ['35', '1440']) {
      expect(parseSettingForm(definition('booking.holdMinutes'), form({ 'booking.holdMinutes': good }))).toBe(Number(good));
    }
  });
});

describe('merge-then-validate backstop', () => {
  // A row failing its own SettingKind bound (e.g. holdMinutes=0) never reaches
  // mergeAndValidateSettings's validateConfig call — applySettingOverrides drops it first. Its
  // own throw path is only reachable via a genuine cross-field rule (see below); single-field
  // rejection happens one layer up, at parseSettingForm.
  it('save path (mergeAndValidateSettings): accepts a stored holdMinutes exactly at the [35, 1440] boundary', () => {
    expect(mergeAndValidateSettings(config, { 'booking.holdMinutes': JSON.stringify(35) }).booking.holdMinutes).toBe(35);
    expect(mergeAndValidateSettings(config, { 'booking.holdMinutes': JSON.stringify(1440) }).booking.holdMinutes).toBe(1440);
  });

  it('load path (loadMergedConfig): falls back to the file config value and warns when a stored holdMinutes row is outside [35, 1440]', () => {
    for (const bad of [0, 34, 1441]) {
      const warnings: SettingsLoadWarning[] = [];
      const merged = loadMergedConfig(config, { 'booking.holdMinutes': JSON.stringify(bad) }, (warning) => warnings.push(warning));
      expect(merged.booking.holdMinutes).toBe(config.booking.holdMinutes);
      expect(warnings).toEqual([{ key: 'booking.holdMinutes', reason: expect.any(String) }]);
    }
  });

  it('load path: keeps a stored holdMinutes row exactly at the [35, 1440] boundary, with no warning', () => {
    for (const good of [35, 1440]) {
      const warnings: SettingsLoadWarning[] = [];
      const merged = loadMergedConfig(config, { 'booking.holdMinutes': JSON.stringify(good) }, (warning) => warnings.push(warning));
      expect(merged.booking.holdMinutes).toBe(good);
      expect(warnings).toEqual([]);
    }
  });

  it('cross-field: an individually valid setting submission is still rejected when the full merged config violates a real validateConfig rule, with SettingsMergeError carrying validateConfig\'s {path, message} issue shape', () => {
    // Starts from an already-inconsistent base because no two *editable* settings can combine
    // into a cross-field violation — the only true cross-field rule is locales.default must be in
    // locales.supported, and locales isn't an editable SettingDefinition. Hand-breaking locales is
    // the only way to exercise mergeAndValidateSettings's cross-field path at all.
    const brokenLocalesConfig: ResolvedClientConfig = { ...config, locales: { supported: ['pt-BR'], default: 'en' } };
    try {
      mergeAndValidateSettings(brokenLocalesConfig, { 'booking.minNoticeHours': '2' });
      throw new Error('expected mergeAndValidateSettings to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsMergeError);
      expect((error as SettingsMergeError).issues).toEqual([
        { path: ['locales', 'default'], message: 'must be included in locales.supported' },
      ]);
    }
  });

  it('cross-field: the load path falls back to the pristine config when the offending path cannot be attributed to a stored setting key', () => {
    const brokenLocalesConfig: ResolvedClientConfig = { ...config, locales: { supported: ['pt-BR'], default: 'en' } };
    const warnings: SettingsLoadWarning[] = [];
    const merged = loadMergedConfig(brokenLocalesConfig, { 'booking.minNoticeHours': '2' }, (warning) => warnings.push(warning));
    expect(merged).toBe(brokenLocalesConfig);
    expect(warnings).toEqual([{ key: '*', reason: expect.stringContaining('must be included in locales.supported') }]);
  });
});
