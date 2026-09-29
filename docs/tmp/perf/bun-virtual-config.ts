// Lets Bun scripts import handlers directly: serves Astro's virtual config module from the test stub.
import { plugin } from 'bun';

plugin({
  name: 'reserva-virtual-config',
  setup(build) {
    build.module('virtual:reserva/config', async () => ({
      exports: { default: (await import('../../../tests/virtual-config.ts')).default },
      loader: 'object',
    }));
  },
});
