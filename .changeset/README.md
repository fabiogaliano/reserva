# Changesets

Two packages ship from this repository — `@reservajs/astro` (the repository root) and
`@reservajs/stripe` (`packages/stripe`) — and they version independently. Add a changeset in
the same PR as the change it describes:

```sh
bun run changeset
```

Release day: `bun run release:version` (applies pending changesets, bumps versions, writes each
package's `CHANGELOG.md`), commit, then `bun run release:publish`. Publish `@reservajs/astro`
before `@reservajs/stripe`, which declares it as a peer.

The root package is listed as `"."` in the root `workspaces` array. That is what makes the
published root package visible to changesets at all — `@manypkg` only reports packages matched
by the workspace globs, so without it a changeset naming `@reservajs/astro` is rejected as "not
in the workspace".

The `0.2.0` entries in both changelogs were written by hand: they cover the whole pre-public
history, which predates this tool.
