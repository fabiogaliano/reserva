# Customization

How to restyle, reword or replace what Reserva renders and sends.

## Components and theming

Reserva renders the confirmation page, `/booking/manage` and `/booking/admin` itself, and ships
one component, `ManageBooking.astro`: a form where a customer enters their booking token. It
submits a `GET` to `/booking/manage`, so it needs no CSRF token and works on a static page.
Pass `endpoint` when `routes.manage` is off.

The booking form is yours to build. The reference one is
[`examples/smoke-site/src/components/BookingWidget.astro`](../examples/smoke-site/src/components/BookingWidget.astro),
which the e2e suite runs against. It reads pickup options from the catalog and every price from
`quote`, so the price shown always matches the price charged. Copy it and change it freely.

### Tokens

All styling goes through `--bk-*` custom properties, with light defaults and a
`prefers-color-scheme: dark` set. Override them in your CSS: on `:root` for the pages, on
`.bk-embed` for the component. The defaults have zero specificity, so your rules win in both
modes. If you change the accent, set all four accent tokens, since the others don't follow
`--bk-accent`:

```css
.bk-embed, :root {
  --bk-accent: #8a5a00;
  --bk-accent-contrast: #ffffff;
  --bk-accent-soft: #f6eedf;
  --bk-accent-text: #7a5000;
}
```

The component stylesheet (`dist/ui/components.css`, bundled by your build) only sets tokens on
`.bk-embed`, so it never changes your page's colors. It follows a `data-theme="light"` or
`"dark"` attribute on any ancestor, or the OS setting. The pages load
`/booking/assets/reserva.css` and `reserva.js` from content-hashed URLs. Printed pages always use
the light palette.

Focus shows as a 2px `--bk-accent` outline, which stays visible in Windows forced-colors mode.
`--bk-accent-text` is the accent shade for text on `--bk-accent-soft` and `--bk-surface-2`.

Tokens are declared once, in `src/ui/tokens.css`. This table is generated from it by
`bun run docs:contract`:

<!-- generated:ui-tokens -->
| Token | Light default | Dark default |
|---|---|---|
| `--bk-font` | `"Inter", "Inter Variable", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` | same as light |
| `--bk-bg` | `#f3f4f6` | `#0a0a0c` |
| `--bk-surface` | `#ffffff` | `#141517` |
| `--bk-surface-2` | `#eceef1` | `#1d1e21` |
| `--bk-text` | `#282a30` | `#ededef` |
| `--bk-text-muted` | `#63666d` | `#8a8f98` |
| `--bk-border` | `#e0e2e6` | `#2b2c30` |
| `--bk-accent` | `#5e6ad2` | `#7c86e2` |
| `--bk-accent-contrast` | `#ffffff` | `#14162b` |
| `--bk-accent-soft` | `#eceefb` | `#232647` |
| `--bk-accent-text` | `#5763c3` | `#7f88e3` |
| `--bk-danger` | `#b3261e` | `#f2a099` |
| `--bk-danger-contrast` | `#ffffff` | `#2a100e` |
| `--bk-danger-soft` | `#fbeae9` | `#3a201e` |
| `--bk-warning` | `#8a5a00` | `#e0b568` |
| `--bk-warning-soft` | `#f9efd8` | `#362a13` |
| `--bk-ok` | `#1d7a3f` | `#8fd0a0` |
| `--bk-ok-soft` | `#e4f2e9` | `#1c3123` |
| `--bk-masthead-text` | `#ededef` | same as light |
| `--bk-masthead-muted` | `#8a8f98` | same as light |
| `--bk-masthead-brand` | `#a9b1ef` | same as light |
| `--bk-radius` | `12px` | same as light |
| `--bk-radius-sm` | `8px` | same as light |
| `--bk-shadow` | `0 1px 2px rgb(20 21 26 / 0.05), 0 8px 28px rgb(20 21 26 / 0.05)` | `0 1px 2px rgb(0 0 0 / 0.5), 0 8px 28px rgb(0 0 0 / 0.4)` |
| `--bk-ease` | `cubic-bezier(0.16, 1, 0.3, 1)` | same as light |
<!-- /generated:ui-tokens -->

### Head and favicon

Two keys reach the `<head>` of every page Reserva renders:

```ts
ui: {
  faviconUrl: '/favicon.svg',
  headHtml: '<link rel="preconnect" href="https://fonts.example"><link rel="stylesheet" href="/site-tokens.css">',
}
```

`headHtml` is inserted as is, after Reserva's stylesheet, so your `--bk-*` overrides win.
Reserva doesn't escape or check it, and it must fit the page's Content-Security-Policy.

> **Keep analytics off these pages, or strip the query string.** The manage page URL contains
> the booking's token, and the confirmation URL contains the payment session id. Most analytics
> tools (GA4, Plausible, Matomo) record the full URL, which would let anyone reading the reports
> cancel the booking. Leave these pages untracked, or send the path only (for GA4, set
> `page_location` to `location.origin + location.pathname`).

### Content-Security-Policy

Every page Reserva renders is sent with:

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self';
connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'
```

Nothing on the pages is inline. If your `headHtml`, `faviconUrl` or `branding.logoUrl` loads
from another origin (a font host, a CDN), set `ui.contentSecurityPolicy` to a policy that allows
it, or to `false` to send none and set your own:

```ts
ui: {
  headHtml: '<link rel="stylesheet" href="https://fonts.example/css?family=Inter">',
  contentSecurityPolicy:
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.example; img-src 'self' data:; " +
    "font-src https://fonts.example; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; " +
    "base-uri 'none'; object-src 'none'",
}
```

### Branding the customer pages

`ui.branding` styles the confirmation and manage pages, the way `emails.branding` styles mail.
The admin pages keep Reserva's own look.

```ts
ui: {
  branding: {
    logoUrl: '/brand/logo.svg',   // shown in the masthead, alt = business.name
    logoWidth: 160,
    logoHeight: 40,
    colorScheme: 'light',         // 'auto' (default) | 'light' | 'dark'
    accentColor: '#0f6b3f',       // #rgb or #rrggbb
    mastheadBackground: 'linear-gradient(180deg, #16301f, #0c1a11)',
    fontFamily: '"Fraunces", Georgia, serif',
  },
}
```

- `colorScheme: 'light'` or `'dark'` fixes the scheme and hides the theme toggle. `'auto'`
  follows the OS and the toggle.
- `accentColor` sets `--bk-accent` and derives the other three accent tokens, each readable at
  4.5:1. In dark mode the accent is lightened just enough to read (`#0f6b3f` becomes
  `#448c69`). The focus ring uses the accent, so pick one with at least 3:1 contrast on white;
  `#ffcc00` is only 1.5:1.
- `mastheadBackground` is any CSS `background` value. The masthead text tokens stay the same,
  so override `--bk-masthead-text` and `--bk-masthead-muted` if your masthead is light.
- `fontFamily` sets `--bk-font`. Load the font yourself through `headHtml`.

These values go into the served stylesheet, scoped to `.bk-page--confirmation` and
`.bk-page--manage`, so no inline styles are needed. `mastheadBackground` and `fontFamily` must be
a single CSS value: `;`, `{`, `}`, `<`, `>`, `\`, comments, or an unclosed bracket or quote fail
the build.

To change any other token on the customer pages only, use the same scope in your `headHtml`
stylesheet: `.bk-page--confirmation, .bk-page--manage { --bk-bg: #fbf7ef; }`.

### Status badge placement

```ts
ui: { confirmation: { statusPlacement: 'ticket' } }   // default 'masthead'
```

With `'ticket'`, the "Confirmed" badge moves from above the title into the top right of the
booking ticket (`.bk-ticket-status`). Other states have no ticket and keep the badge in the
masthead.

### Page hooks

These classes and attributes are stable across minor versions. Target them in your CSS rather
than relying on markup order.

| Hook | Where | Values |
|---|---|---|
| `bk-page--confirmation`, `bk-page--manage`, `bk-page--admin`, `bk-page--settings`, `bk-page--partners` | `<body>` | one per page |
| `data-bk-status` | `<body>`, confirmation page | `pending`, `confirmed`, `failed`, `expired`, `cancelled`, `not_found` |
| `data-bk-status` | `<body>`, manage page (not on the invalid-link page) | `hold`, `confirmed`, `cancelled`, `expired`, `no_show` |
| `bk-ticket` | confirmation, confirmed booking | the ticket (`bk-ticket-top`, `bk-ticket-date`, `bk-ticket-body`, `bk-ticket-status`, `bk-ticket-foot`) |
| `bk-whatsnext` | confirmation, confirmed booking | the "What's next" card |
| `bk-summary` | confirmation (after the detail window), manage | the booking details card |
| `bk-message` | confirmation, manage invalid link | the card with the state's message |
| `bk-contact` | confirmation, manage | the "Need help?" card |
| `bk-reschedule`, `bk-cancel`, `bk-no-show` | manage | the reschedule form and the cancel and no-show sections |
| `bk-brand`, `bk-brand-logo` | masthead | the brand line and its logo |
| `bk-list` | any structured message | a bulleted list (see below) |

Example: `[data-bk-status="confirmed"] .bk-masthead { … }`.

## Copy and locales

English and European Portuguese are bundled; English is the default. Every string has a typed
key (`ReservaMessageKey` from `@reservajs/astro/ui`). Override any of them per locale in
`ui.messages`, or through a component's `messages` prop. Regional copy falls back to its base
language, then to the bundled copy, then to English. Customer pages take their locale from the
booking, a `?locale=` parameter, or `locales.default`; the admin uses `admin.locale` when set.
Dates and prices are formatted with `Intl` in the business timezone.

The longer customer messages accept a little structure: the confirmation page's `*Body` keys,
`confirmation.detailsEmailed`, `manage.invalidBody` and `manage.invalidUseEmailLink`. A blank
line starts a new paragraph, and lines starting with `- ` become a list
(`<ul class="bk-list">`). Text is escaped first, so a message can't inject HTML.

```ts
ui: {
  messages: {
    en: {
      'confirmation.whatsNextBody': '- Keep your reference handy\n- Arrive 10 minutes early\n- Hotel pickup? We will confirm the address by email',
    },
  },
}
```

## Email templates

`@reservajs/astro/email` exports the renderer: `renderDefaultEmail`, `EmailRenderer`,
`EmailTemplateContext` and `RenderedEmail` (`{ subject, html, text? }`). There are three levels
of control.

**1. Pick a provider.** `brevoEmail({ apiKey })` sends every booking event with the default
template.

```ts
import { brevoEmail } from '@reservajs/astro/providers/email-brevo';
const email = brevoEmail({ apiKey: env.BREVO_API_KEY });
```

**2. Change branding and copy.** `emails.branding` restyles the template, and `emails.messages`
overrides any copy key per locale. `EmailCopyKey` (from `@reservajs/astro`) types the keys.

```ts
emails: {
  branding: { accentColor: '#0f6b3f' },
  messages: {
    en: { 'refund.timing': 'Refunds arrive in your account within 5-10 business days.' },
    'pt-PT': { 'refund.timing': 'O reembolso chega à sua conta em 5 a 10 dias úteis.' },
  },
},
```

**3. Write your own renderer.** `renderEmail` on a provider replaces the template. Call
`renderDefaultEmail` for the events you don't change:

```ts
import { renderDefaultEmail } from '@reservajs/astro/email';
import { brevoEmail } from '@reservajs/astro/providers/email-brevo';

const email = brevoEmail({
  apiKey: env.BREVO_API_KEY,
  renderEmail(context) {
    if (context.event === 'booking.no_show') {
      return { subject: 'We missed you', html: '<p>...</p>' };
    }
    return renderDefaultEmail(context);
  },
});
```

For another service (Resend, Postmark, SES), implement `EmailProvider` and use
`renderDefaultEmail` the same way. `send` and `sendToRecipient` receive the route config as their
last argument: build manage links from `paths.managePage`, and leave them out when
`groups.manage` is false. [`providers.md`](./providers.md) covers the ports.

## Other providers

Each provider has its own import path, so only the ones you use end up in your bundle:
`@reservajs/astro/providers/email-brevo`, `@reservajs/astro/providers/email-none` and
`@reservajs/astro/providers/calendar-google`.
