# Customization

Where Reserva's rendered output and its non-payment side effects can be restyled, re-worded,
or replaced outright.

## Components and theming

The package includes one embeddable component — `ManageBooking.astro` (token entry form) — plus
the full pages (confirmation, `/booking/manage`, `/booking/admin`) the injected routes
server-render. Day capacity and closures are managed on `/booking/admin`, which runs behind your
admin auth.

The reference booking widget lives at
[`../examples/smoke-site/src/components/BookingWidget.astro`](../examples/smoke-site/src/components/BookingWidget.astro),
a real consumer of the public API exercised by this repository's e2e suite: it reads pickup
options from `/api/booking/catalog` and every price from `/api/booking/quote`, so the amount
displayed can never disagree with the amount charged. Copy it and change it freely.

`ManageBooking.astro` submits a `GET` to `/booking/manage`, so it needs no CSRF token and can be
placed on a static page. Pass an explicit `endpoint` when `routes.manage` is disabled.

**Theming.** All styling flows through `--bk-*` custom properties (light defaults plus
`prefers-color-scheme: dark`). Rebrand by overriding tokens in site CSS, for example
`.bk-embed, :root { --bk-accent: #d9a406; }`. Component styles ship as
`dist/ui/components.css`, bundled by the consumer's build; the server-rendered pages load
their stylesheet from `/booking/assets/reserva.css` and their calendar/enhancer script from
`/booking/assets/reserva.js`, both referenced through content-hashed URLs with year-long
cache headers.

Every token is declared once, in `src/ui/tokens.css`; the pages' stylesheet and the components'
stylesheet both source their defaults from it, so overriding one token reaches both surfaces. The
table below is generated from that file by `bun run docs:contract`.

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
| `--bk-focus` | `0 0 0 3px color-mix(in srgb, var(--bk-accent) 50%, transparent)` | same as light |
| `--bk-ease` | `cubic-bezier(0.16, 1, 0.3, 1)` | same as light |
<!-- /generated:ui-tokens -->

### Head and favicon

Two `config.ui` keys reach the `<head>` of every page Reserva server-renders (confirmation,
`/booking/manage`, `/booking/admin`, admin settings):

```ts
ui: {
  faviconUrl: '/favicon.svg',
  headHtml: '<link rel="preconnect" href="https://fonts.example"><link rel="stylesheet" href="/site-tokens.css">',
}
```

`faviconUrl` becomes `<link rel="icon" href="…">`. `headHtml` is emitted **verbatim, after**
Reserva's own stylesheet link, so a `--bk-*` override in it wins over the defaults. It is trusted
markup: Reserva never escapes or parses it, and keeping it within your Content-Security-Policy is
your responsibility.

### Branding the customer pages

`config.ui.branding` does for the confirmation and `/booking/manage` pages what
`emails.branding` does for mail. The operator pages (`/booking/admin`, settings) keep Reserva's
own look and dark mode.

```ts
ui: {
  branding: {
    logoUrl: '/brand/logo.svg',   // an <img> in the masthead, alt = business.name
    logoWidth: 160,
    logoHeight: 40,
    colorScheme: 'light',         // 'auto' (default) | 'light' | 'dark'
    accentColor: '#0f6b3f',       // #rgb or #rrggbb
    mastheadBackground: 'linear-gradient(180deg, #16301f, #0c1a11)',
    fontFamily: '"Fraunces", Georgia, serif',
  },
}
```

- `colorScheme: 'light' | 'dark'` renders `<html data-theme="…">` on the customer pages
  whatever the viewer's saved choice, and leaves out the theme toggle. `'auto'` keeps the
  OS/toggle behavior.
- `accentColor` sets `--bk-accent`, derives `--bk-accent-contrast` (white or near-black,
  whichever contrasts more), `--bk-accent-soft` and `--bk-focus`. The same accent applies in
  both schemes.
- `mastheadBackground` is any CSS `background` value. The masthead text tokens
  (`--bk-masthead-text`, `--bk-masthead-muted`) stay as they are, so override them yourself if
  you pick a light masthead.
- `fontFamily` sets `--bk-font`. Loading the font is up to you, through `headHtml`.

The values are written into the served stylesheet (`/booking/assets/reserva.css`), scoped to
`.bk-page--confirmation` and `.bk-page--manage`. No inline styles are added, so `style-src 'self'`
is still enough. `mastheadBackground` and `fontFamily` must be one CSS value: `;`, `{`, `}`, `<`,
`>`, `\` and comment markers fail the build.

To override any other token for the customer pages only, scope it the same way in your
`headHtml` stylesheet, for example
`.bk-page--confirmation, .bk-page--manage { --bk-bg: #fbf7ef; }`. With `colorScheme` pinned,
you don't have to win against the dark-scheme selectors.

### Status badge placement

```ts
ui: { confirmation: { statusPlacement: 'ticket' } }   // default 'masthead'
```

With `'ticket'`, the "Confirmed" badge on a confirmed booking moves from above the title into
the top-right of the booking ticket (`.bk-ticket-status`). Every other state has no ticket, so
its badge stays in the masthead.

### Page hooks

These classes and attributes are public API. They stay stable across minor versions, so use
them in your CSS instead of markup order or `:has()`.

| Hook | Where | Values |
|---|---|---|
| `bk-page--confirmation`, `bk-page--manage`, `bk-page--admin`, `bk-page--settings` | `<body>` | one per page |
| `data-bk-status` | `<body>`, confirmation page | `pending`, `confirmed`, `failed`, `expired`, `cancelled`, `not_found` |
| `data-bk-status` | `<body>`, manage page (not on the invalid-link page) | the booking's status: `hold`, `confirmed`, `cancelled`, `expired`, `no_show` |
| `bk-ticket` | confirmation, confirmed booking | the ticket (`bk-ticket-top`, `bk-ticket-date`, `bk-ticket-body`, `bk-ticket-status`, `bk-ticket-foot`) |
| `bk-whatsnext` | confirmation, confirmed booking | the "What's next" card |
| `bk-summary` | confirmation (after the detail window), manage | the booking-facts card |
| `bk-message` | confirmation, manage invalid link | the card carrying the state's message |
| `bk-contact` | confirmation, manage | the "Need help?" contact card |
| `bk-reschedule`, `bk-cancel`, `bk-no-show` | manage | the reschedule form card and the cancel / no-show disclosures |
| `bk-brand`, `bk-brand-logo` | masthead | the brand line and its logo `<img>` |
| `bk-list` | any structured message | a bulleted list (see below) |

Example: `[data-bk-status="confirmed"] .bk-masthead { … }`.

### Structured messages

The long-form customer messages accept a small amount of structure: the confirmation page's
`*Body` keys, `confirmation.detailsEmailed`, `manage.invalidBody` and
`manage.invalidUseEmailLink`. A blank line starts a new paragraph. Consecutive lines that start
with `- ` become one `<ul class="bk-list">`, which is indented so wrapped lines line up under
their text. The text is escaped before any markup is added, so a message can never inject HTML.
A message with no `- ` lines and no blank lines renders exactly as before.

```ts
ui: {
  messages: {
    en: {
      'confirmation.whatsNextBody': '- Keep your reference handy\n- Arrive 10 minutes early\n- Hotel pickup? We will confirm the address by email',
    },
  },
}
```

**CSP.** Nothing Reserva renders is inline: external same-origin assets only
(`style-src 'self'`/`script-src 'self'` suffice), plain POST forms, and meta-refresh polling
on the pending-payment state. The manage page's reschedule keeps a native `datetime-local`
input as the no-JS fallback.

**UI copy and locales.** English and European Portuguese are bundled; English is the default.
Every rendered string uses the typed key set from `@reservajs/astro/ui` (`defaultMessages`,
`resolveMessages`, `formatMessage`, `ReservaMessageKey`). Override per locale under
`config.ui.messages` or via a `messages` prop; resolution layers region-specific copy over its
base language, deployment overrides over bundled copy, and English as the final fallback.
Customer pages pick their locale from the booking, a `?locale=` parameter, or
`locales.default`; the admin surfaces use `config.admin.locale` when set. Dates and prices are
formatted with `Intl` in the business timezone.

## Email templates

`@reservajs/astro/email` exports the provider-agnostic renderer: `renderDefaultEmail`,
`EmailRenderer`, `EmailTemplateContext`, and `RenderedEmail` (`{ subject, html, text? }`).
Configuring an email provider is the only switch; three levels, each layering on the previous:

1. **Choose a provider, get the default template.** `brevoEmail({ apiKey })` renders every
   booking event with `renderDefaultEmail` automatically.

   ```ts
   import { brevoEmail } from '@reservajs/astro/providers/email-brevo';
   const email = brevoEmail({ apiKey: env.BREVO_API_KEY });
   ```

2. **Branding and copy overrides.** `config.emails.branding` restyles the HTML shell;
   `config.emails.messages` overrides any copy key per locale, merged over the bundled
   English/European Portuguese catalogs. `EmailCopyKey` (from the package root) types the
   override map.

   ```ts
   emails: {
     branding: { accentColor: '#0f6b3f' },
     messages: {
       en: { 'refund.timing': 'Refunds arrive in your account within 5-10 business days.' },
       'pt-PT': { 'refund.timing': 'O reembolso chega à sua conta em 5 a 10 dias úteis.' },
     },
   },
   ```

3. **Full custom renderer.** `renderEmail: EmailRenderer` on a provider replaces the whole
   template. Because `renderDefaultEmail` is public, a custom renderer can override one event
   and delegate the rest:

   ```ts
   import { renderDefaultEmail } from '@reservajs/astro/email';
   import { brevoEmail } from '@reservajs/astro/providers/email-brevo';

   const email = brevoEmail({
     apiKey: env.BREVO_API_KEY,
     renderEmail(context) {
       if (context.event === 'booking.no_show') {
         return { subject: 'We missed you', html: '<p>...</p>' };
       }
       return renderDefaultEmail(context); // every other event keeps the shipped template
     },
   });
   ```

   A non-Brevo transport (Resend, Postmark, SES, …) implements `EmailProvider`
   (`send`/`sendToRecipient`) and imports `renderDefaultEmail` the same way. Both methods
   receive the resolved route config (`ReservaResolvedRouteConfig`) as their last argument:
   use `paths.managePage` to build manage links, and skip them when `groups.manage` is false.

## Other providers

Import each provider from its own subpath: `@reservajs/astro/providers/email-brevo`,
`@reservajs/astro/providers/email-none`, `@reservajs/astro/providers/calendar-google`. Each
subpath imports only the provider you construct.
