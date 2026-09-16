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
  settingDefinitionsFor,
  type SettingsLoadWarning,
} from '../src/core/settings';
import { config } from './fixtures';

function definition(key: string) {
  const found = settingDefinitionsFor(config).find((entry) => entry.key === key);
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

describe('service opening hours (per schedule rule departures, interval and days)', () => {
  const FIRST = 'services.vintage.schedule.0.firstStart';
  const LAST = 'services.vintage.schedule.0.lastStart';
  const INTERVAL = 'services.vintage.schedule.0.intervalMin';
  const DAYS = 'services.vintage.schedule.0.days';

  it('generates the four editable fields of each schedule rule, in the hours section', () => {
    const hours = settingDefinitionsFor(config).filter((entry) => entry.section === 'hours');
    expect(hours.map((entry) => entry.key)).toEqual([FIRST, LAST, INTERVAL, DAYS]);
    // One heading per rule: every field of a rule shares its group and rule metadata.
    expect(hours.every((entry) => entry.groupKey === 'services.vintage.schedule.0')).toBe(true);
    expect(hours.every((entry) => entry.scheduleRule?.serviceSlug === 'vintage')).toBe(true);
    expect(hours[0]?.scheduleRule).toMatchObject({ serviceSlug: 'vintage', rule: config.services.vintage?.schedule[0] });
    // The static list stays free of per-deployment keys.
    expect(settingDefinitions.some((entry) => entry.section === 'hours')).toBe(false);
  });

  it('applies stored hours to the rule without mutating the file config', () => {
    const merged = applySettingOverrides(config, { [FIRST]: '"10:00"', [LAST]: '"15:30"' });
    expect(merged.services.vintage?.schedule[0]).toMatchObject({ firstStart: '10:00', lastStart: '15:30' });
    expect(config.services.vintage?.schedule[0]).toMatchObject({ firstStart: '09:00', lastStart: '12:00' });
    // Service fields the overrides don't touch come through the clone unchanged; occupancy is
    // declarative data now, not a function the clone had to preserve by reference.
    expect(merged.services.vintage?.occupancy).toEqual(config.services.vintage?.occupancy);
  });

  it('ignores stored hours that are not HH:MM', () => {
    const merged = applySettingOverrides(config, { [FIRST]: '"9am"', [LAST]: '"25:00"' });
    expect(merged.services.vintage?.schedule[0]).toMatchObject({ firstStart: '09:00', lastStart: '12:00' });
  });

  it('parses HH:MM form values and rejects anything else', () => {
    expect(parseSettingForm(definition(FIRST), form({ [FIRST]: '08:30' }))).toBe('08:30');
    for (const bad of ['', '8:30', '08:30:00', '24:00', 'noon']) {
      expect(() => parseSettingForm(definition(FIRST), form({ [FIRST]: bad }))).toThrow(SettingParseError);
    }
  });

  it('save path rejects a first departure after the last departure', () => {
    expect(() => mergeAndValidateSettings(config, { [FIRST]: '"14:00"' })).toThrow(SettingsMergeError);
    expect(mergeAndValidateSettings(config, { [FIRST]: '"11:00"' }).services.vintage?.schedule[0]?.firstStart).toBe('11:00');
  });

  it('applies a stored interval and day set, sorting the days', () => {
    const merged = applySettingOverrides(config, { [INTERVAL]: '45', [DAYS]: '[5,1,0]' });
    expect(merged.services.vintage?.schedule[0]?.intervalMin).toBe(45);
    expect(merged.services.vintage?.schedule[0]?.days).toEqual([0, 1, 5]);
    expect(config.services.vintage?.schedule[0]?.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('ignores stored day sets that are empty, out of range, duplicated, or not an array', () => {
    for (const bad of ['[]', '[7]', '[-1]', '[1,1]', '[1.5]', '["1"]', '"1,2"', 'null']) {
      const merged = applySettingOverrides(config, { [DAYS]: bad });
      expect(merged.services.vintage?.schedule[0]?.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });

  it('ignores stored intervals outside 1..1440', () => {
    for (const bad of ['0', '-30', '1441', '30.5', '"30"']) {
      const merged = applySettingOverrides(config, { [INTERVAL]: bad });
      expect(merged.services.vintage?.schedule[0]?.intervalMin).toBe(30);
    }
  });

  it('parses the day checkboxes into a sorted, deduplicated set and rejects anything else', () => {
    expect(parseSettingForm(definition(DAYS), form({ [DAYS]: ['5', '1', '1', '0'] }))).toEqual([0, 1, 5]);
    expect(parseSettingForm(definition(DAYS), form({ [DAYS]: '3' }))).toEqual([3]);
    // No box ticked at all: the form field is absent, which must fail before validateConfig sees it.
    expect(() => parseSettingForm(definition(DAYS), form({}))).toThrow(SettingParseError);
    for (const bad of [['7'], ['x'], [''], ['1', '9']]) {
      expect(() => parseSettingForm(definition(DAYS), form({ [DAYS]: bad }))).toThrow(SettingParseError);
    }
  });

  it('parses the interval within its bounds and rejects anything else', () => {
    expect(parseSettingForm(definition(INTERVAL), form({ [INTERVAL]: '45' }))).toBe(45);
    expect(parseSettingForm(definition(INTERVAL), form({ [INTERVAL]: '1440' }))).toBe(1440);
    for (const bad of ['0', '-1', '1441', '30.5', '', 'half an hour']) {
      expect(() => parseSettingForm(definition(INTERVAL), form({ [INTERVAL]: bad }))).toThrow(SettingParseError);
    }
  });

  it('load path drops only the hours rows behind an invalid rule and keeps the rest', () => {
    const warnings: SettingsLoadWarning[] = [];
    const merged = loadMergedConfig(config, { [FIRST]: '"14:00"', 'booking.minNoticeHours': '2' }, (warning) => warnings.push(warning));
    expect(merged.services.vintage?.schedule[0]?.firstStart).toBe('09:00');
    expect(merged.booking.minNoticeHours).toBe(2);
    expect(warnings).toEqual([{ key: FIRST, reason: expect.stringContaining('validateConfig rejected') }]);
  });
});

describe('service pricing (per tier amount)', () => {
  const TIER0 = 'services.vintage.pricing.0.priceMinor';
  const TIER3 = 'services.vintage.pricing.3.priceMinor';
  // A zero-decimal currency: the form value IS the stored amount, with no cents to parse.
  const jpyConfig: ResolvedClientConfig = { ...config, business: { ...config.business, currency: 'jpy' } };
  const jpyDefinition = (key: string) => {
    const found = settingDefinitionsFor(jpyConfig).find((entry) => entry.key === key);
    if (!found) throw new Error(`unknown setting ${key}`);
    return found;
  };

  it('generates one amount per pricing rule, in the pricing section, grouped per service', () => {
    const pricing = settingDefinitionsFor(config).filter((entry) => entry.section === 'pricing');
    expect(pricing.map((entry) => entry.key)).toEqual([
      TIER0, 'services.vintage.pricing.1.priceMinor', 'services.vintage.pricing.2.priceMinor', TIER3,
    ]);
    expect(pricing.every((entry) => entry.groupKey === 'services.vintage.pricing')).toBe(true);
    // The resolved localized title names the group now; the slug fallback is gone.
    expect(pricing[0]?.pricingTier).toMatchObject({ serviceSlug: 'vintage', serviceTitle: 'Vintage Tour', rule: config.services.vintage?.pricing[0] });
    expect(pricing[0]?.kind).toEqual({ type: 'money', currency: 'eur' });
    // maxQuantity and pickup stay deploy-time: only the amount is editable.
    expect(pricing.map((entry) => entry.key.endsWith('.priceMinor'))).toEqual([true, true, true, true]);
    expect(settingDefinitions.some((entry) => entry.section === 'pricing')).toBe(false);
  });

  it('applies a stored amount without mutating the file config', () => {
    const merged = applySettingOverrides(config, { [TIER0]: '15000' });
    expect(merged.services.vintage?.pricing[0]?.priceMinor).toBe(15000);
    expect(config.services.vintage?.pricing[0]?.priceMinor).toBe(10000);
    // Untouched tiers still come from the file config.
    expect(merged.services.vintage?.pricing[3]?.priceMinor).toBe(20000);
  });

  it('ignores stored amounts that are negative, fractional, or not a number', () => {
    for (const bad of ['-1', '150.5', '"150"', 'null']) {
      const merged = applySettingOverrides(config, { [TIER0]: bad });
      expect(merged.services.vintage?.pricing[0]?.priceMinor).toBe(10000);
    }
  });

  it('parses major-unit form values into minor units', () => {
    expect(parseSettingForm(definition(TIER0), form({ [TIER0]: '150' }))).toBe(15000);
    expect(parseSettingForm(definition(TIER0), form({ [TIER0]: '150.00' }))).toBe(15000);
    expect(parseSettingForm(definition(TIER0), form({ [TIER0]: '150.5' }))).toBe(15050);
    expect(parseSettingForm(definition(TIER0), form({ [TIER0]: '150,50' }))).toBe(15050);
    expect(parseSettingForm(definition(TIER0), form({ [TIER0]: ' 0 ' }))).toBe(0);
    // Binary floating point makes 1.15 * 100 = 114.99999999999999; rounding keeps the cent.
    expect(parseSettingForm(definition(TIER0), form({ [TIER0]: '1.15' }))).toBe(115);
  });

  it('rejects amounts with too many decimals, negatives, and non-numbers', () => {
    for (const bad of ['150.005', '-1', 'abc', '', '1.2.3', '1,2,3']) {
      expect(() => parseSettingForm(definition(TIER0), form({ [TIER0]: bad }))).toThrow(SettingParseError);
    }
  });

  it('a zero-decimal currency takes the amount as-is and refuses decimals', () => {
    expect(parseSettingForm(jpyDefinition(TIER0), form({ [TIER0]: '4500' }))).toBe(4500);
    expect(() => parseSettingForm(jpyDefinition(TIER0), form({ [TIER0]: '4500.5' }))).toThrow(SettingParseError);
  });

  it('save path keeps a valid amount and the load path drops an invalid stored row', () => {
    expect(mergeAndValidateSettings(config, { [TIER0]: '16000' }).services.vintage?.pricing[0]?.priceMinor).toBe(16000);
    const warnings: SettingsLoadWarning[] = [];
    const merged = loadMergedConfig(config, { [TIER3]: '-5' }, (warning) => warnings.push(warning));
    expect(merged.services.vintage?.pricing[3]?.priceMinor).toBe(20000);
    expect(warnings).toEqual([{ key: TIER3, reason: expect.any(String) }]);
  });
});
