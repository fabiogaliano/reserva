---
"@reservajs/astro": minor
---

Theme fixes: token overrides work as documented, focus is easier to see, and branded pages read well in dark mode.

**Breaking:** the `--bk-focus` token is removed. Focus is now a solid 2px outline in `--bk-accent`, which also shows in Windows forced-colors mode. Styles that used `var(--bk-focus)` need their own ring.

- A plain `:root { --bk-accent: … }` (or `.bk-embed { … }` for the component) now wins in dark mode too. Before, the dark defaults beat it.
- `<ManageBooking />` no longer changes the host page's colors. Its tokens live on `.bk-embed`, and it follows `data-theme` on any ancestor, otherwise the OS setting.
- New `--bk-accent-text` token for accent-colored text, used by the accent badge and the ticket month, now at 4.5:1 contrast. If you override `--bk-accent` alone, set `--bk-accent-text` too, or those stay indigo.
- `ui.branding.accentColor` gets a lighter version in dark mode, just light enough to read (`#0f6b3f` becomes `#448c69`).
- Printed pages always use the light palette.
- The page assets are cached for a year only under their current `?v=` hash, so a stale URL is never cached.
- A list in the masthead no longer overlaps the text above it.
- `ui.branding.fontFamily` and `mastheadBackground` reject an unclosed `(`, `[` or quote, which used to break the rest of the stylesheet.
