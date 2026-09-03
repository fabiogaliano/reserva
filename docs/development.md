# Development

Running Reserva's own repository: the local interactive demo, the test suites, and what CI
enforces.

## Local interactive demo

[`../examples/smoke-site`](../examples/smoke-site) runs the complete booking flow locally
through Astro dev, Cloudflare workerd, and persistent local D1, with simulated
payment/calendar/email/admin-auth providers. It never contacts an external service.

```bash
cd examples/smoke-site
bun run demo
```

Open <http://localhost:4321>. Create a booking, follow the simulated checkout, inspect
`/booking/admin`. The dev-server logs print customer and operator management URLs. See
[`../examples/smoke-site/README.md`](../examples/smoke-site/README.md) for the route list and
reset instructions.

## Tests and checks

```sh
bun install
bun run verify           # typecheck + generated docs + unit/component + workers
bun run verify:packaged  # built preview, cron Worker, packed consumers, README quickstart
bun run check            # audit + both of the above
bun run test:e2e         # Playwright, against examples/smoke-site
```

`test:workers` applies the real D1 migrations through `@cloudflare/vitest-pool-workers`;
`test:pack` packs both tarballs and builds two throwaway consumers against them;
`test:quickstart` executes the README's own quickstart blocks, so a quickstart that stops
working fails the build rather than the next reader.

The contract tables in [`../README.md`](../README.md) and [`../AGENTS.md`](../AGENTS.md) are
generated from the package's exported constants: run `bun run docs:contract` after changing
routes, error codes, or booking events (`bun run docs:contract:check` runs in CI).

[`architecture.md`](./architecture.md) records the invariants a change must not break.
Security reports: see [`../SECURITY.md`](../SECURITY.md).
