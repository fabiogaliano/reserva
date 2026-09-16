---
"@reservajs/astro": minor
---

Add the `settings.changed` event so a static site can rebuild from admin edits. `SETTINGS_EVENTS`
and `WEBHOOK_EVENTS` (`BOOKING_EVENTS` + `SETTINGS_EVENTS`) are exported from
`@reservajs/astro/core`, and `config.webhooks[].events` and hook `events` filters now validate
against `WEBHOOK_EVENTS`. The event fires once per admin save — settings, settings reset, day
overrides and capacity defaults — carrying the `admin_changes` rows the save wrote:
`{ apiVersion: 1, id: 'settings/<changeBatchId>', event: 'settings.changed', occurredAt,
data: { changes: [{ domain, key, action, actor }] } }`. Delivery is non-durable (the outbox is
keyed by booking): signed and POSTed from the admin request via `waitUntil`, three attempts with
2 s/8 s backoff, then `logger.error('settings webhook delivery failed', { name, status })` and no
incident row. Subscribers receive it only by naming it explicitly, so booking-only subscribers are
unaffected. In-process hooks get `(event, null, { id, occurredAt, config, changes })`, narrowed by
the event name.
