import { describe, expect, it } from 'vitest';
import { pageShell } from '../src/ui/layout';

describe('pageShell head customization', () => {
  const html = pageShell({
    lang: 'en',
    page: 'manage',
    title: 'Manage',
    cssHref: '/api/booking/assets.css',
    body: '<p>body</p>',
    favicon: '/favicon.svg',
    headHtml: '<link rel="stylesheet" href="/site.css">',
  });

  it('emits the favicon link once', () => {
    expect(html.match(/<link rel="icon" href="\/favicon\.svg">/g)).toHaveLength(1);
  });

  it('places the consumer head HTML once, after the library stylesheet, so its rules win the cascade', () => {
    const library = html.indexOf('<link rel="stylesheet" href="/api/booking/assets.css">');
    const consumer = html.indexOf('<link rel="stylesheet" href="/site.css">');
    expect(library).toBeGreaterThan(-1);
    expect(consumer).toBeGreaterThan(library);
    expect(html.split('/site.css')).toHaveLength(2);
  });

  it('emits neither when unset', () => {
    const plain = pageShell({ lang: 'en', page: 'manage', title: 'Manage', cssHref: '/a.css', body: '' });
    expect(plain).not.toContain('rel="icon"');
  });
});
