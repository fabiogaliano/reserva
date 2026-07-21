import runtime from 'virtual:bookkit/runtime';
import routeConfig from 'virtual:bookkit/config';
import type { BookkitContext } from '../context';
import type { BookkitRuntimeRequest } from '../runtime-context';

// Every route entrypoint must see the SAME resolved (prefixed) route table + group flags the
// integration injected it under. `runtime.createContext` is authored by the consumer's own
// runtimeEntrypoint, wired up independently of `routePrefix`/`routes` (see runtime-context.ts), so
// it has no way to know about them — this seam overwrites the context's default (unprefixed)
// routeConfig with the real per-build one right after creation, uniformly, so no entrypoint file
// can forget it and end up rendering a half-prefixed URL.
export async function createRouteContext(input: BookkitRuntimeRequest): Promise<BookkitContext> {
  const context = await runtime.createContext(input);
  return { ...context, routeConfig };
}
