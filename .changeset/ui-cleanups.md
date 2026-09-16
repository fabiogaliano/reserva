---
"@reservajs/astro": patch
---

UI cleanups. Removed the dead message keys `common.back`, `admin.backToAdmin`,
`common.brandFallback` and `common.time`, and moved the `widget.*` keys (and
`SLOT_STATUS_MESSAGE_KEYS`) out of the library into the example booking widget that was their only
consumer, so `ReservaMessageKey` covers only what Reserva renders. `src/ui/tokens.css` is now the
one place a `--bk-*` default is declared, included by both the pages' stylesheet and the
components' stylesheet, and `bun run docs:contract` generates the token table in
`docs/customization.md` from it. `ManageBooking.astro` applies the deployment's own
`config.ui.messages` before the `messages` prop. Email times follow the locale's hour cycle
instead of being forced to 24-hour.
