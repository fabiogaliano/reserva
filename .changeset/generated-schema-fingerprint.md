---
"@reservajs/astro": minor
---

The schema fingerprint is generated from the migrations instead of hand-maintained.

`scripts/generate-schema-fingerprint.ts` replays `migrations/*.sql` (CREATE TABLE columns, CREATE
INDEX names, ALTER TABLE ADD/DROP/RENAME COLUMN, and the rebuild-and-rename pattern) into
`src/generated/schema-fingerprint.ts`. `bun run build` runs it first; it can also be run alone. The
generated module is committed (`bun run generate:check` fails when it drifts from its inputs) and exports `RESERVA_MIGRATIONS` (so `src/migrations-manifest.ts` is
gone) plus the table/column/index sets the isolate-time check now compares `PRAGMA table_info` and
`sqlite_master` against — no more hand-written per-table probes drifting from the SQL. The pre-v2
column probe is kept solely as the "this database predates the v2 rename" detector.

`reserva-migrate` also writes its derived wrangler config under `os.tmpdir()` (removed in a
`finally` and on `SIGINT`, and pinned back to the project with `--cwd`) instead of beside the
consumer's config, and preflights `wrangler --version` with an actionable "install wrangler" error.
