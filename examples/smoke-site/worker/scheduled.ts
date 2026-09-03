// A separate Worker because the Astro adapter's generated entry exports only `fetch`. It shares the
// D1 binding (see ./wrangler.jsonc) but inherits no secrets — configure those on this Worker too.
import { scheduledHandler } from '../../../src/runtime';
import runtime from '../src/runtime';

export default { scheduled: scheduledHandler(runtime) };
