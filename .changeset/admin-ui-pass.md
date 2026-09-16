---
"@reservajs/astro": minor
---

Rework the admin dashboard and settings pages around a lighter, one-screen-at-a-time layout.

The dashboard is now three tabs (`?tab=upcoming` / `availability` / `attention`) over a day-grouped booking list. Each booking is a native `<details>` row showing time, customer, service · party size · place, and a status only when it is not confirmed; opening it reveals the reference, contact details, price, pickup and booked-on date alongside a **Manage** link. The bookings table is gone, so the list no longer clips on narrow screens. The availability calendar drops the per-cell `units x/y` label in favour of a state dot, keeping the unit load in the cell's accessible name and tooltip. A header link jumps straight to the attention tab, with a count badge when incidents are open.

Settings now read as sentences: each setting is a plain statement with its value in bold and a **Change** action that swaps in the control. A service's departure window, interval and weekdays collapse into two sentences instead of four separate fields.

Both pages keep working with scripting off. Tabs are real links with every panel server-rendered, rows are native disclosures, and settings render the sentence and its control together, with the browser-side script collapsing the control only once it has run.
