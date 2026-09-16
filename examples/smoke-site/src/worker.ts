// The site's own Worker entry, pointed at by `main` in wrangler.jsonc. `@astrojs/cloudflare` honours
// a custom `main`, so `fetch` and `scheduled` ship as one Worker with one set of bindings and
// secrets — no second Worker for the cron.
import { handle } from '@astrojs/cloudflare/handler';
import { scheduledHandler } from '../../../src/runtime';
import runtime, { type Env } from './runtime';

export default {
  fetch: handle,
  scheduled: scheduledHandler(runtime),
} satisfies ExportedHandler<Env>;
