import type { D1Database } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import type { ResolvedClientConfig } from '../src/core/config';
import { validateConfig } from '../src/core/config';
import type { StatusResponse } from '../src/core/api';
import { createReservaContext } from '../src/context';
import { handleAdminGet } from '../src/handlers';
import { resolveRouteConfig } from '../src/routes-manifest';
import { cssAssetHref } from '../src/ui/asset-hrefs';
import { accentContrastColor, brandingCss } from '../src/ui/branding';
import { messageHtml } from '../src/ui/layout';
import { confirmationPage } from '../src/ui/pages/confirmation-page';
import { renderManageErrorPage, renderManagePage } from '../src/ui/pages/manage-page';
import { themeCss } from '../src/ui/theme';
import { config } from './fixtures';
import { fakeRepository, providers } from './fakes';

const branded = vi.hoisted(() => ({
  ui: {
    branding: { accentColor: '#0f6b3f', mastheadBackground: 'linear-gradient(180deg, #fdf6e3, #f5ecd7)', fontFamily: '"Fraunces", serif' },
  },
}));

vi.mock('virtual:reserva/config', async () => {
  const { resolveRouteConfig: routes } = await import('../src/routes-manifest');
  const { config: fixtureConfig } = await import('./fixtures');
  return { default: { config: { ...fixtureConfig, ...branded }, routes: routes() } };
});

const routeConfig = resolveRouteConfig();
const url = 'https://example.test/booking-confirmation?sessionId=cs_1';
const fullBooking = {
  reference: 'LVT-2026-001',
  serviceSlug: 'vintage',
  serviceTitle: 'Vintage Tour',
  start: '2026-06-15T09:00:00.000+01:00',
  end: '2026-06-15T10:00:00.000+01:00',
  quantity: 2,
  priceMinor: 10000,
  currency: 'eur',
  meetingPoint: null,
  locale: 'en',
  metadataRows: [],
};
const confirmed = { status: 'confirmed', booking: fullBooking } as StatusResponse;

function withUi(ui: NonNullable<ResolvedClientConfig['ui']>): ResolvedClientConfig {
  return { ...config, ui };
}

describe('messageHtml (structure in long-form messages)', () => {
  it('renders a message with no list lines and no blank lines exactly as the single paragraph it was', () => {
    expect(messageHtml('Save your reference.')).toBe('<p>Save your reference.</p>');
    expect(messageHtml('One\nTwo', 'bk-lead')).toBe('<p class="bk-lead">One\nTwo</p>');
    expect(messageHtml('')).toBe('<p></p>');
  });

  it('turns consecutive "- " lines into one list and blank lines into paragraph breaks', () => {
    expect(messageHtml('Before you go:\n- Bring your reference\n- Arrive early\n\nSee you soon.')).toBe(
      '<p>Before you go:</p><ul class="bk-list"><li>Bring your reference</li><li>Arrive early</li></ul><p>See you soon.</p>',
    );
    expect(messageHtml('First.\r\n\r\nSecond.', 'bk-lead')).toBe('<p class="bk-lead">First.</p><p class="bk-lead">Second.</p>');
  });

  it('escapes before adding structure, so a message can never carry markup', () => {
    expect(messageHtml('- <img src=x onerror=alert(1)>\n- a & b')).toBe(
      '<ul class="bk-list"><li>&lt;img src=x onerror=alert(1)&gt;</li><li>a &amp; b</li></ul>',
    );
  });

  it('reaches the confirmation page "what\'s next" card from ui.messages', () => {
    const html = confirmationPage(
      { config: withUi({ messages: { en: { 'confirmation.whatsNextBody': '- Keep your reference\n- Arrive 10 minutes early' } } }), routeConfig },
      confirmed,
      url,
      null,
    );
    expect(html).toContain('<section class="bk-card bk-whatsnext"><h2>What&#39;s next</h2><ul class="bk-list"><li>Keep your reference</li><li>Arrive 10 minutes early</li></ul></section>');
  });
});

describe('page hook classes', () => {
  it('names the page and the confirmation state on <body>', () => {
    const html = confirmationPage({ config, routeConfig }, confirmed, url, null);
    expect(html).toContain('<body class="bk-page bk-page--confirmation" data-bk-status="confirmed">');
    expect(html).toContain('<section class="bk-ticket">');
    const failed = confirmationPage({ config, routeConfig }, { status: 'failed', booking: null } as StatusResponse, url, null);
    expect(failed).toContain('data-bk-status="failed"');
    expect(failed).toContain('<section class="bk-card bk-message">');
    expect(failed).toContain('<section class="bk-card bk-contact">');
  });

  it('names the manage page with the booking status, and each of its cards', () => {
    const html = renderManagePage(
      { role: 'customer', canCancel: true, canReschedule: true, token: 't', booking: { ...fullBooking, status: 'confirmed' } },
      '/booking/manage',
    );
    expect(html).toContain('<body class="bk-page bk-page--manage" data-bk-status="confirmed">');
    expect(html).toContain('class="bk-card bk-summary bk-col-side"');
    expect(html).toContain('class="bk-card bk-reschedule"');
    expect(html).toContain('class="bk-disclosure bk-card--danger bk-cancel"');
    expect(renderManageErrorPage('/booking/manage')).toContain('<body class="bk-page bk-page--manage">');
  });
});

describe('ui.confirmation.statusPlacement', () => {
  it("moves the confirmed badge from the masthead into the ticket with 'ticket'", () => {
    const html = confirmationPage({ config: withUi({ confirmation: { statusPlacement: 'ticket' } }), routeConfig }, confirmed, url, null);
    const masthead = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(masthead).not.toContain('bk-badge');
    expect(html).toContain('<div class="bk-ticket-body"><div class="bk-ticket-status"><span class="bk-badge bk-badge--ok">Confirmed</span></div><dl');
  });

  it('keeps the masthead badge where no ticket is rendered', () => {
    const summary = {
      status: 'confirmed',
      booking: { reference: 'LVT-2026-001', serviceTitle: 'Vintage Tour', start: fullBooking.start, end: fullBooking.end, locale: 'en' },
    } as StatusResponse;
    const html = confirmationPage({ config: withUi({ confirmation: { statusPlacement: 'ticket' } }), routeConfig }, summary, url, null);
    expect(html.slice(html.indexOf('<header'), html.indexOf('</header>'))).toContain('bk-badge--ok');
    expect(html).not.toContain('bk-ticket-status');
  });
});

describe('ui.branding', () => {
  it('renders the logo as a real <img> named after the business', () => {
    const branding = { logoUrl: '/brand/logo.svg', logoWidth: 160, logoHeight: 40 };
    const html = confirmationPage({ config: withUi({ branding }), routeConfig }, confirmed, url, null);
    expect(html).toContain('<p class="bk-brand"><a href="https://example.test"><img class="bk-brand-logo" src="/brand/logo.svg" alt="Example City Tours" width="160" height="40"></a></p>');
    const manage = renderManageErrorPage('/booking/manage', { businessName: 'Example City Tours', branding });
    expect(manage).toContain('<p class="bk-brand"><img class="bk-brand-logo" src="/brand/logo.svg" alt="Example City Tours" width="160" height="40"></p>');
  });

  it("pins a customer page to the configured scheme over the viewer's cookie and drops the toggle", () => {
    const html = confirmationPage({ config: withUi({ branding: { colorScheme: 'light' } }), routeConfig, viewerTheme: 'dark' }, confirmed, url, null);
    expect(html).toContain('<html lang="en" data-theme="light">');
    expect(html).not.toContain('data-reserva-theme-toggle');
    const manage = renderManagePage({ booking: { ...fullBooking, status: 'confirmed' } }, '/booking/manage', { theme: 'dark', branding: { colorScheme: 'light' } });
    expect(manage).toContain('data-theme="light"');
    expect(manage).not.toContain('data-reserva-theme-toggle');
  });

  it("keeps following the viewer with 'auto'", () => {
    const html = confirmationPage({ config: withUi({ branding: { colorScheme: 'auto' } }), routeConfig, viewerTheme: 'dark' }, confirmed, url, null);
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('data-reserva-theme-toggle');
  });

  it('leaves the operator dashboard on its own theme and toggle', async () => {
    const context = createReservaContext({
      config: withUi({ branding: { colorScheme: 'light', logoUrl: '/brand/logo.svg' } }),
      db: {} as D1Database,
      repo: fakeRepository(),
      clock: () => new Date('2026-06-14T08:00:00.000Z'),
      adminAuth: async () => ({ subject: '' }),
      providers: providers(),
      viewerTheme: 'dark',
    });
    const body = await (await handleAdminGet(new Request('https://example.test/booking/admin'), context)).text();
    expect(body).toContain('data-theme="dark"');
    expect(body).toContain('data-reserva-theme-toggle');
    expect(body).toContain('<body class="bk-page bk-page--admin">');
    expect(body).not.toContain('bk-brand-logo');
  });

  it('generates token overrides scoped to the customer pages only', () => {
    const css = brandingCss(branded.ui.branding);
    expect(css).toContain('.bk-page--confirmation, .bk-page--manage {');
    expect(css).toContain('--bk-accent: #0f6b3f;');
    expect(css).toContain('--bk-accent-contrast: #ffffff;');
    expect(css).toContain('--bk-focus: 0 0 0 3px color-mix(in srgb, #0f6b3f 50%, transparent);');
    expect(css).toContain('--bk-font: "Fraunces", serif;');
    expect(css).toContain('.bk-page--confirmation .bk-masthead, .bk-page--manage .bk-masthead { background: linear-gradient(180deg, #fdf6e3, #f5ecd7); }');
    expect(css).not.toContain('bk-page--admin');
    expect(brandingCss(undefined)).toBe('');
    expect(brandingCss({ colorScheme: 'light' })).toBe('');
  });

  it('picks the legible text color for the accent', () => {
    expect(accentContrastColor('#0f6b3f')).toBe('#ffffff');
    expect(accentContrastColor('#f5c518')).toBe('#14151a');
    expect(accentContrastColor('#fff')).toBe('#14151a');
  });

  it('versions the stylesheet URL by the branding and leaves an unbranded URL alone', () => {
    const plain = cssAssetHref('/booking/assets/reserva.css');
    expect(cssAssetHref('/booking/assets/reserva.css', { colorScheme: 'light' })).toBe(plain);
    const brandedHref = cssAssetHref('/booking/assets/reserva.css', branded.ui.branding);
    expect(brandedHref).not.toBe(plain);
    expect(brandedHref.startsWith(plain)).toBe(true);
  });

  it('serves the branding rules from the stylesheet route, after the defaults', async () => {
    const { GET } = await import('../src/routes/booking/assets');
    const css = await GET().text();
    expect(css.startsWith(themeCss)).toBe(true);
    expect(css.slice(themeCss.length)).toBe(brandingCss(branded.ui.branding));
  });

  it('rejects values that could escape their declaration in the served stylesheet', () => {
    const withBranding = (branding: Record<string, unknown>) => ({ ...config, ui: { branding } });
    expect(() => validateConfig(withBranding({ accentColor: 'green' }))).toThrow(/accentColor.*hex/s);
    expect(() => validateConfig(withBranding({ mastheadBackground: 'red; } body { display: none' }))).toThrow(/mastheadBackground/);
    expect(() => validateConfig(withBranding({ fontFamily: 'Inter /* x' }))).toThrow(/fontFamily/);
    expect(() => validateConfig(withBranding({ colorScheme: 'sepia' }))).toThrow(/colorScheme/);
    expect(() => validateConfig(withBranding(branded.ui.branding))).not.toThrow();
  });
});
