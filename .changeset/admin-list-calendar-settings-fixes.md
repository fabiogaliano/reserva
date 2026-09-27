---
"@reservajs/astro": minor
---

Admin dashboard fixes.

- **One bookings list.** Choose Upcoming or Past (`?when=`), then filter by status or search within that period. "All" now includes every status, so a status filter can never show more rows than "All". Upcoming starts at midnight in the business timezone, so bookings from earlier today stay visible.
- **Paging.** 50 rows per page with "Showing X–Y of Z". A search reads up to 20,000 bookings and says so if it stops there. The "Show later bookings" link and `?until=` are gone.
- Filters, tabs, day links and page links keep the current list state. Filter options have their own labels ("Awaiting payment", "No-show", …).
- **Calendar.** Each day shows the most units in use at the same time against capacity, plus the number of bookings (`2/2 peak · 3 bookings`), across the whole booking horizon. The calendar is one Tab stop with arrow-key navigation. With JavaScript, multi-day selection replaces the "To date" field.
- A blank capacity is rejected instead of closing the day. Settings resets are validated like saves, Enter in a settings field saves, and schedule `days` are sorted and de-duplicated.
- A failed admin action returns to the same page with a readable message instead of JSON. An expired form says "This page expired". Access and Origin failures still return 403.
- The Attention badge shows the real number of open incidents. Retry is hidden where it can't help (oversell, payment verification, reconciliation).

Removed message keys: `admin.all`, `admin.showLaterBookings`, `admin.unitsLoad`. New: `admin.whenLabel`, `admin.whenUpcoming`, `admin.whenPast`, `admin.filterAll`, `admin.filterConfirmed`, `admin.filterHold`, `admin.filterExpired`, `admin.filterCancelled`, `admin.filterNoShow`, `admin.noPastBookings`, `admin.noMatchingBookings`, `admin.pageRange`, `admin.pagination`, `admin.pagePrev`, `admin.pageNext`, `admin.searchTruncated`, `admin.dayLoad`, `admin.bookingCountOne`, `admin.bookingCount`, `admin.dayOpen`, `admin.incidentsTruncated`, `admin.errorGeneric`, `admin.errorInvalid`, `admin.errorInvalidField`, `admin.errorExpired`, `admin.errorNotFound`.
