---
"@reservajs/astro": minor
---

Add `config.ui.faviconUrl` and `config.ui.headHtml`. The favicon becomes a `<link rel="icon">` on every server-rendered page (confirmation, manage, admin, settings); `headHtml` is emitted verbatim after Reserva's own stylesheet link, so consumer CSS and `--bk-*` overrides take precedence. It is trusted markup and the consumer's CSP responsibility.
