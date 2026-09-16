---
"@reservajs/astro": minor
---

Service titles are required and localized, and travel on every wire shape.

`services.<slug>.title` is now required and takes `LocalizedText` (a string or a
`Record<locale, string>`), as do meeting-point labels and pickup labels/hints. `serviceTitle` is
added to `WireBooking`, `ConfirmationBooking` and `ManageBooking`, and `CatalogService.title` is
resolved for the request locale. Every renderer — manage page, confirmation facts, the ICS summary
and Google Calendar link, admin rows and search, settings groups, emails — reads the resolved
title; the `title ?? slug` fallbacks are gone. `resolveMetadataFieldLabel` is renamed
`resolveLocalizedText` (the old name stays as an alias for one release) and
`resolveServiceTitle(config, slug, locale)` is exported. The Stripe line item defaults to the
localized title.
