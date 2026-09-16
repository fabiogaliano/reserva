---
"@reservajs/astro": minor
---

Pickup ids are opaque; pickup labels are required.

`pickupOptions[].label` is now required and localized, and `hint` is localized too. The special
handling of the ids `default` and `custom` is gone from the catalog, admin, settings and manage
renderers: address rows key off `requiresAddress` alone, and an option the service no longer
declares renders its raw id with no address row. The implied `meeting_point` option — the one a
meeting-points-only service gets for free — is named from the new message key `pickup.meetingPoint`
("Meeting point" / "Ponto de encontro"). `widget.pickupDefault`, `widget.pickupDefaultHint`,
`widget.pickupCustom` and `widget.pickupCustomHint` are removed from the message catalog.
