---
"@reservajs/astro": minor
---

`astro dev` bypasses the admin gate automatically. When `config.admin.access` is set and the build
came from `astro dev`, the admin and operator routes resolve `{ subject: 'dev' }` without calling
Cloudflare Access — which cannot protect `localhost` — and log `admin auth bypassed: astro dev`
once per isolate. Ops health reports `security.adminAuth: 'dev-bypass'` in that state. The flag
behind it comes from Astro's build command, never from runtime env, so `astro build` and
`astro preview` output always calls Access, and a custom `adminAuth` is never bypassed. Consumers
can delete the hand-written dev `adminAuth` they used to need.
