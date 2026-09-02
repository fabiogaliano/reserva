// Locale negotiation. The cases below are the ones the first consumer had to shim around in its
// own code before this existed.
import { describe, expect, it } from 'vitest';
import { resolveLocale } from '../src/core/locale';

const ptOnly = { supported: ['pt-PT'], default: 'pt-PT' };
const multi = { supported: ['pt-PT', 'en'], default: 'en' };

describe('resolveLocale', () => {
  it('matches a bare language tag onto its supported regional variant', () => {
    expect(resolveLocale(ptOnly, 'pt')).toBe('pt-PT');
    expect(resolveLocale(multi, 'pt')).toBe('pt-PT');
  });

  it('matches a different regional variant of a supported language', () => {
    expect(resolveLocale(ptOnly, 'pt-BR')).toBe('pt-PT');
    expect(resolveLocale(multi, 'en-US')).toBe('en');
  });

  it('prefers the longest matching prefix over an earlier-declared shorter one', () => {
    const locales = { supported: ['pt', 'pt-BR'], default: 'pt' };
    expect(resolveLocale(locales, 'pt-BR')).toBe('pt-BR');
    expect(resolveLocale(locales, 'pt-AO')).toBe('pt');
  });

  it('falls back to the default for a tag sharing no language subtag', () => {
    expect(resolveLocale(multi, 'de-CH')).toBe('en');
    expect(resolveLocale(ptOnly, 'ja')).toBe('pt-PT');
  });

  it('falls back to the default for a missing or empty request', () => {
    expect(resolveLocale(multi, null)).toBe('en');
    expect(resolveLocale(multi, undefined)).toBe('en');
    expect(resolveLocale(multi, '')).toBe('en');
  });

  it('is case- and separator-insensitive but returns the declared tag verbatim', () => {
    expect(resolveLocale(multi, 'PT-pt')).toBe('pt-PT');
    expect(resolveLocale(multi, 'pt_PT')).toBe('pt-PT');
  });

  it('resolves an exact supported tag to itself', () => {
    expect(resolveLocale(multi, 'en')).toBe('en');
    expect(resolveLocale(multi, 'pt-PT')).toBe('pt-PT');
  });
});
