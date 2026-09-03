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
