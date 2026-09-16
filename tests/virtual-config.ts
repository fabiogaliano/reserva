import { resolveRouteConfig, type ReservaVirtualConfig } from '../src/routes-manifest';
import { config } from './fixtures';

// Stand-in for the integration-generated `virtual:reserva/config` in the unit and workers projects,
// which run without the Astro pipeline. Tests that need a different config `vi.mock` this specifier.
const virtualConfig: ReservaVirtualConfig = { config, routes: resolveRouteConfig() };

export default virtualConfig;
