---
"@reservajs/astro": minor
---

Operational alerts now have a shipped sink, wired by default.

`EmailProvider` gains an optional `sendMessage({ to, subject, html, text })` for a plain message
with no booking behind it. The Brevo adapter implements it over the same transport and
`ProviderFailure` mapping as its booking sends; `email-none` implements it as a logged no-op.

`emailAlertSink(email, { to? })` is exported from `@reservajs/astro/runtime`. It renders through the
existing branded email shell using new `alert.subject`/`alert.body` copy keys (en and pt-PT,
overridable via `config.emails.messages`) and throws at construction if the provider has no
`sendMessage`.

When `providers.alerts` is absent and `providers.email?.sendMessage` exists, the runtime wires
`emailAlertSink(providers.email, { to: business.contact.email })` automatically and logs it once, so
a deployment with an email provider no longer has to pass `requireAlertSink: false`. An explicit
`providers.alerts` still wins.
