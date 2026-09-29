---
"@reservajs/astro": minor
---

Every page Reserva renders (confirmation, `/booking/manage`, `/booking/admin`, admin settings) now sends a strict `Content-Security-Policy` header: only same-origin scripts, styles, images, fonts and requests, forms posting back to the site, and no embedding in frames.

**Check this before upgrading if your `ui.headHtml`, `ui.faviconUrl` or `ui.branding.logoUrl` loads anything from another origin** (a font host, a CDN): the browser now blocks it. Set `ui.contentSecurityPolicy` to a policy that allows it, or to `false` to send no header and keep your own. See "Content-Security-Policy" in docs/customization.md.
