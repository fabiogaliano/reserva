declare module 'virtual:bookkit/runtime' {
  import type { BookkitRuntimeDefinition } from './runtime';

  const runtime: BookkitRuntimeDefinition;
  export default runtime;
}

declare module 'virtual:bookkit/config' {
  import type { BookkitResolvedRouteConfig } from './routes-manifest';

  const routeConfig: BookkitResolvedRouteConfig;
  export default routeConfig;
}
