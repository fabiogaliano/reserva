import { describe, expect, it } from 'vitest';
import {
  SettingParseError,
  applySettingOverrides,
  parseSettingForm,
  settingDefinitions,
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
      'business.contact.email': JSON.stringify('new@example.test'),
      'payments.methods': JSON.stringify(['card']),
    });
    expect(merged.booking.minNoticeHours).toBe(2);
    expect(merged.booking.reschedule.enabled).toBe(false);
    expect(merged.business.contact.email).toBe('new@example.test');
    expect(merged.payments.methods).toEqual(['card']);
    // Untouched values still come from the file config, and the original is not mutated.
    expect(merged.booking.maxHorizonDays).toBe(config.booking.maxHorizonDays);
    expect(config.booking.minNoticeHours).toBe(24);
    expect(config.payments.methods).toEqual(['card', 'mb_way']);
  });

  it('ignores unknown keys, malformed JSON, and values that fail validation', () => {
    const merged = applySettingOverrides(config, {
      'no.such.setting': '5',
      'booking.minNoticeHours': 'not-json{',
      'booking.maxHorizonDays': '"twelve"',
      'booking.holdMinutes': '-3',
      'payments.methods': JSON.stringify(['bitcoin']),
      'legal.termsUrl': JSON.stringify('javascript:alert(1)'),
      'booking.limitedThreshold': '1',
    });
    expect(merged.booking.minNoticeHours).toBe(config.booking.minNoticeHours);
    expect(merged.booking.maxHorizonDays).toBe(config.booking.maxHorizonDays);
    expect(merged.booking.holdMinutes).toBe(config.booking.holdMinutes);
    expect(merged.payments.methods).toEqual(config.payments.methods);
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

  it('parses form values per kind: numbers, checkboxes, methods, and optional empties', () => {
    expect(parseSettingForm(definition('booking.minNoticeHours'), form({ 'booking.minNoticeHours': '1.5' }))).toBe(1.5);
    expect(parseSettingForm(definition('booking.maxHorizonDays'), form({ 'booking.maxHorizonDays': '45' }))).toBe(45);
    expect(parseSettingForm(definition('booking.reschedule.enabled'), form({ 'booking.reschedule.enabled': 'on' }))).toBe(true);
    expect(parseSettingForm(definition('booking.reschedule.enabled'), form({}))).toBe(false);
    expect(parseSettingForm(definition('booking.maxHoldsPerIp'), form({ 'booking.maxHoldsPerIp': '' }))).toBeNull();
    expect(parseSettingForm(definition('business.contact.whatsapp'), form({}))).toBeNull();
    expect(parseSettingForm(definition('payments.methods'), form({ 'payments.methods': ['card', 'mb_way', 'card'] }))).toEqual(['card', 'mb_way']);
  });

  it('rejects invalid form values with SettingParseError', () => {
    expect(() => parseSettingForm(definition('booking.maxHorizonDays'), form({ 'booking.maxHorizonDays': '2.5' }))).toThrow(SettingParseError);
    expect(() => parseSettingForm(definition('booking.maxHorizonDays'), form({ 'booking.maxHorizonDays': '0' }))).toThrow(SettingParseError);
    expect(() => parseSettingForm(definition('business.name'), form({ 'business.name': '   ' }))).toThrow(SettingParseError);
    expect(() => parseSettingForm(definition('business.contact.email'), form({ 'business.contact.email': 'not-an-email' }))).toThrow(SettingParseError);
    expect(() => parseSettingForm(definition('legal.termsUrl'), form({ 'legal.termsUrl': 'ftp://example.test' }))).toThrow(SettingParseError);
    expect(() => parseSettingForm(definition('payments.methods'), form({}))).toThrow(SettingParseError);
  });
});
