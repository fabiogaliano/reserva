---
"@reservajs/astro": minor
---

Operator-only metadata fields and an opt-in admin tag, two independent settings on a `metadataFields` entry.

- **`visibility: 'customer' | 'operator'`** (default `'customer'`). An `'operator'` field is still validated at checkout and stored on the booking, but is left out of the catalog, the confirmation page and its status payload, the customer's manage page and `/api/booking/manage` answer (both `metadata` and `metadataRows`), and customer emails. The operator's manage view and owner emails still show it. The visitor's browser still sends the value, so treat it as a claim, not a verified fact.
- **`adminBadge: true`** asks the admin to show the field's value as a tag on the booking. Allowed on `type: 'select'` only; config validation rejects it on any other type, naming the key path.
- **The customer's `/api/booking/manage` `metadata` now carries only keys the service currently declares as customer-visible.** A value stored under a key that is no longer declared, such as a field removed from config, is no longer returned to the customer; the operator's manage view still has it. The rendered pages and emails already showed declared fields only.

Apart from that last point, a config that sets neither behaves exactly as before.
