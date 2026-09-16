---
"@reservajs/astro": minor
---

Add a **Pricing** tab to the admin settings page. Every pricing tier of every service exposes its amount as an editable setting (`services.<slug>.pricing.<index>.priceMinor`), grouped per service and labelled by the tier's quantity band and pickup option. Amounts are typed in major units (`150`, `150.50`, or `150,50`) and stored as the integer minor-unit value config already uses, with the currency's own decimal count deciding what is accepted. A tier's `maxQuantity` and `pickup` stay deploy-time.
