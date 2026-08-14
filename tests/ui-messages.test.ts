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

  it('uses European Portuguese by default and keeps English selectable', () => {
    expect(defaultLocale).toBe('pt-PT');
    expect(resolveMessages(undefined, undefined)['widget.title']).toBe('Reservar este tour');
    expect(resolveMessages(undefined, 'pt-PT')['widget.title']).toBe('Reservar este tour');
    expect(resolveMessages(undefined, 'pt-pt')['widget.title']).toBe('Reservar este tour');
    expect(resolveMessages(undefined, 'en')['widget.title']).toBe('Book this tour');
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
