// A separate Worker (own wrangler config, own `main`), not a wrapper around the Astro adapter's
// generated entry — that file is regenerated every build, so patching it risks losing injected
// routes, assets, and bindings.
import { scheduledHandler } from '@reservajs/astro/runtime';
import runtime from './runtime';

export default { scheduled: scheduledHandler(runtime) };
