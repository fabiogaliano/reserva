// The consumer's own Worker entry, pointed at by `main` in wrangler.jsonc. `@astrojs/cloudflare`
// honours a custom `main`, so `fetch` and `scheduled` ship as one Worker with one set of bindings
// and secrets — the packed tarball has to make that reachable from `@reservajs/astro/runtime`.
import { handle } from '@astrojs/cloudflare/handler';
import { scheduledHandler } from '@reservajs/astro/runtime';
import runtime, { type Env } from '../runtime';

export default {
  fetch: handle,
  scheduled: scheduledHandler(runtime),
} satisfies ExportedHandler<Env>;
