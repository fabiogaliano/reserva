import { describe, expect, it } from 'vitest';
import type { ClientConfig } from '../src/core/config';
import portuguesePortugalCatalog from '../src/ui/locales/pt-PT.json';
import { defaultLocale, defaultMessages, resolveMessages } from '../src/ui/messages';

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}

describe('bundled UI messages', () => {
  it('ships complete European Portuguese copy with the same placeholders as English', () => {
    expect(Object.keys(portuguesePortugalCatalog).sort()).toEqual(Object.keys(defaultMessages).sort());
    for (const key of Object.keys(defaultMessages) as Array<keyof typeof defaultMessages>) {
      expect(placeholders(portuguesePortugalCatalog[key]), key).toEqual(placeholders(defaultMessages[key]));
    }
  });

  // Plan 026 (design decision 4): a generic library must not default to Portuguese — both real
  // consumers set config.locales.default explicitly, so this only affects a caller supplying no
  // locale at all.
  it('uses English by default and keeps European Portuguese selectable', () => {
    expect(defaultLocale).toBe('en');
    expect(resolveMessages(undefined, undefined)['widget.title']).toBe('Book now');
    expect(resolveMessages(undefined, 'en')['widget.title']).toBe('Book now');
    expect(resolveMessages(undefined, 'pt-PT')['widget.title']).toBe('Reservar agora');
    expect(resolveMessages(undefined, 'pt-pt')['widget.title']).toBe('Reservar agora');
  });

  it('layers deployment overrides over bundled base and regional copy', () => {
    const config = {
      ui: {
        messages: {
          pt: { 'widget.title': 'Reserva base' },
          'pt-PT': { 'widget.submit': 'Pagar agora' },
        },
      },
    } as unknown as ClientConfig;

    const messages = resolveMessages(config, 'pt-PT');
    expect(messages['widget.title']).toBe('Reserva base');
    expect(messages['widget.submit']).toBe('Pagar agora');
    expect(messages['widget.date']).toBe('Escolha uma data');
  });
});
