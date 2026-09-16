import { describe, expect, it } from 'vitest';
import type { ResolvedClientConfig } from '../src/core/config';
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

  // A generic library must not default to Portuguese — both real consumers set
  // config.locales.default explicitly, so this only affects a caller supplying no locale at all.
  it('uses English by default and keeps European Portuguese selectable', () => {
    expect(defaultLocale).toBe('en');
    expect(resolveMessages(undefined, undefined)['widget.date']).toBe('Pick a date');
    expect(resolveMessages(undefined, 'en')['widget.date']).toBe('Pick a date');
    expect(resolveMessages(undefined, 'pt-PT')['widget.date']).toBe('Escolha uma data');
    expect(resolveMessages(undefined, 'pt-pt')['widget.date']).toBe('Escolha uma data');
  });

  it('layers deployment overrides over bundled base and regional copy', () => {
    const config = {
      ui: {
        messages: {
          pt: { 'widget.date': 'Escolha o dia' },
          'pt-PT': { 'widget.time': 'Escolha o horário' },
        },
      },
    } as unknown as ResolvedClientConfig;

    const messages = resolveMessages(config, 'pt-PT');
    expect(messages['widget.date']).toBe('Escolha o dia');
    expect(messages['widget.time']).toBe('Escolha o horário');
    expect(messages['widget.loadingSlots']).toBe('A verificar a disponibilidade…');
  });
});
