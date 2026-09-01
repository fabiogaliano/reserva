# Examples

`minimal/` is the smallest complete wiring of the integration — a config plus a runtime
entrypoint, nothing else. It's typechecked as part of the repo and doubles as the fixture
the integration tests import against, so keep it minimal on purpose: anything added here is
also exercised by every test that imports it.

`configs/` has complete config shapes for a handful of different businesses, useful for
seeing how the same schema bends across booking types.

`smoke-site/` is a runnable reference app — a full Astro site wired against the library,
usable for local development and as the target for the end-to-end tests.
