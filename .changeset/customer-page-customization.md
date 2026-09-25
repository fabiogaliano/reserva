---
"@reservajs/astro": minor
---

Customer pages can now be customized without CSS workarounds.

- **Structured messages.** In the confirmation page's `*Body` messages, `confirmation.detailsEmailed`, `manage.invalidBody` and `manage.invalidUseEmailLink`, a blank line starts a new paragraph and consecutive `- ` lines become a `<ul class="bk-list">` with a hanging indent. The text is escaped first, so messages still can't carry HTML. A message with neither renders exactly as before.
- **Page hooks.** `<body>` carries `bk-page--confirmation` / `bk-page--manage` / `bk-page--admin` / `bk-page--settings`. On the confirmation page it also has `data-bk-status` set to the status state, and on the manage page `data-bk-status` is the booking's status. Cards gain `bk-whatsnext`, `bk-summary`, `bk-message`, `bk-contact`, `bk-reschedule`, `bk-cancel` and `bk-no-show`. These names are public and stable across minor versions (see `docs/customization.md`).
- **`ui.branding`** for the confirmation and manage pages: `logoUrl` (+ `logoWidth`/`logoHeight`) renders an `<img>` in the masthead with the business name as alt text. `colorScheme: 'light' | 'dark'` pins the palette and drops the theme toggle. `accentColor` (hex) sets the accent and a computed contrast color. `mastheadBackground` and `fontFamily` are also available. The values are added to the served stylesheet, scoped to the customer pages, so pages still need only `style-src 'self'`. Operator pages are unchanged.
- **`ui.confirmation.statusPlacement: 'masthead' | 'ticket'`** (default `'masthead'`): `'ticket'` moves the confirmed badge into the top-right of the booking ticket.

For a deployment that sets none of these options, the only output change is the new hook classes and attributes. The stylesheet gains the `.bk-list`, `.bk-brand-logo` and `.bk-ticket-status` rules.
