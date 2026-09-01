// Reserva's own compiler needs this declaration; integration.ts injects the equivalent consumer type during Astro builds.
declare module 'virtual:reserva/runtime' {
  import type { ReservaRuntimeDefinition } from './runtime';

  const runtime: ReservaRuntimeDefinition;
  export default runtime;
}

declare module 'virtual:reserva/config' {
  import type { ReservaResolvedRouteConfig } from './routes-manifest';

  const routeConfig: ReservaResolvedRouteConfig;
  export default routeConfig;
}
