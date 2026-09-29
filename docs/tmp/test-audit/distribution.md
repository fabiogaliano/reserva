# Test-audit ledger: distribution lane

Read-only discovery, 2026-09-29. Baseline (docs/tmp/test-audit/baseline-unit.json): every lane
file passes. integration-smoke.test.ts:7 takes ~25.2 s (an `astro build` inside `bun run test`).

Scope: tests/integration-adapter-check, integration-entry, integration-env-schema,
integration-runtime, integration-smoke, providers-tree-shake, route-customization,
runtime-context-types. Also read for overlap: src/integration.ts, src/runtime-context.ts,
src/runtime.ts, src/routes-manifest.ts, src/routes/route-context.ts, src/routes/api/booking/webhooks/payment.ts,
package.json, scripts/{pack,quickstart,smoke-preview,smoke-scheduled}-test.ts, .github/workflows/ci.yml,
vitest.config.ts, tests/workers/{runtime-workerd,smoke-runtime}.test.ts, tests/routes-manage-group.test.ts,
tests/component/customer-page-routes.test.ts, tests/e2e/errors.spec.ts.

CI routing: unit files run in `verify` (`bun run test`); workers suites in `verify`
(`test:workers`); the four scripts run in the `packaged` job on every PR/push; e2e runs `astro dev`.
tsconfig includes `tests/`, so `bun run typecheck` enforces the `@ts-expect-error`/`expectTypeOf` lines.

Counts: 45 declarations. R 30, F 4, C 5, D 6.

## Ledger

### tests/integration-adapter-check.test.ts
| Line | Test | Mark | Evidence |
|---|---|---|---|
| 23 | proceeds silently for the exact @astrojs/cloudflare adapter | R | Regression pin from 3b0c0a8 (throw softened to a warning, exact match). Nothing else runs `astro:config:done`. |
| 28 | warns (does not throw) for a differently-named wrapper/fork adapter | R | Same pin: the old substring check false-positived and hard-blocked forks. |
| 37 | warns (does not throw) when no adapter is configured | R | Pins the `?? 'none'` branch of the advisory. Could share an `it.each` with :28 (cosmetic). |

### tests/integration-entry.test.ts
| Line | Test | Mark | Evidence |
|---|---|---|---|
| 30 | validates at setup and injects every non-prerendered route | C | The `arrayContaining` list at :34-50 is a hand-copied inventory. `toHaveLength(19)` duplicates route-customization:112, which asserts exact, ordered equality with `routeManifest`. The unique assertions are `prerender === false` and `existsSync(entrypoint)`. Carry those two into route-customization:112 (the keeper) and drop the rest. |
| 56 | pins the generated Stripe webhook route to its one-line handlePaymentWebhook delegation | R | A deliberate pin (plan 015, decision 2; history 5bfbc49). tests/workers/webhook.test.ts drives `handlePaymentWebhook` through a hand-written worker, not the generated route. No suite executes `src/routes/api/booking/webhooks/payment.ts` with a signed payload. e2e errors.spec.ts:26 only checks for a non-404. Follow-up: execute `POST` in the component project, as customer-page-routes does for the manage/confirmation routes, and then retire this grep. |
| 65 | resolves the virtual module to the explicit user runtime without serializing config | D | `runtimeVirtualPlugin` runs for real in every component-project route test: vitest.config.ts registers `reserva()`, and customer-page-routes imports routes that resolve `virtual:reserva/runtime` to tests/component/fixtures/runtime.ts. The pack-test and quickstart `astro build`s run it too. The `not.toContain('ECT')` negative dates from the initial commit (92129c7). It is true by construction, since `load` emits only `export { default } from "<path>"`, and config is now serialized on purpose through `virtual:reserva/config` (route-customization:164). |
| 76 | rejects an invalid config during setup | R | The only proof that the integration's single validation pass runs at `astro:config:setup`, so a bad config fails the build. |
| 83 | rejects a missing runtime entrypoint during setup | R | The only test of the `existsSync(entrypoint)` guard. |

### tests/integration-env-schema.test.ts
| Line | Test | Mark | Evidence |
|---|---|---|---|
| 36 | declares reserva's own secrets as optional server secret string fields by default | F | Keep the contract. `expectedNames` is a hand-copy of `reservaSecretEnvSchema` (integration.ts:39-43), which itself hardcodes the strings. The real single truth is the runtime allowlist constants `OPERATOR_SECRET_NAME` (context.ts:124), `CSRF_SECRET_ENV_NAME` (admin-csrf.ts:17) and `TOKEN_ENC_SECRET_NAME` (repo.ts:1007). Enumerate from those, so renaming a runtime secret without updating the schema fails this test. |
| 50 | treats envSchema: true as the default behavior | R | Regression pin from d6fa5f6 ("accept explicit env schema defaults"). |
| 54 | skips the contribution entirely when envSchema is false | R | The only test of the opt-out branch. |

### tests/integration-runtime.test.ts
| Line | Test | Mark | Evidence |
|---|---|---|---|
| 54 | reads injected test bindings without exposing env on context | R | Runtime-factory contract: db/cache come from locals.env, `env` does not leak onto the context, the closed secrets allowlist holds, and `confirmationLocks` is shared per isolate (handlers-status depends on that). runtime-workerd covers only the `cloudflare:workers` fallback branch. |
| 77 | reads reserva's own secrets and every declared webhook secretBinding without them being listed | R | Owner of 8a7fc5a: own names plus `config.webhooks[].secretBinding` plus `secretBindings`, and undeclared names return undefined. |
| 102 | supports direct env locals and worker cache fallback | F | The `getEnv({env})` half duplicates :54, where context.db and context.cache resolve through `getEnv`/`getCache`. The cache half's name promises the `caches.default` fallback, but it only asserts `undefined` in Node, where no `caches` global exists. Repair: assert `context.cache === caches.default` in tests/workers/runtime-workerd.test.ts when no RESERVA_CACHE binding exists. `getEnv` and `getCache` are public (runtime.ts:4-5), so the exports stay. |
| 108 | rejects a missing D1 binding at context-creation time | R | Descriptive-error contract for the binding guard. |
| 116 | rejects a misconfigured (non-D1-shaped) binding before it reaches the repository | C | Same predicate (`!isD1Like(db)`, runtime-context.ts:248) and same message as :108. Fold into one `it.each([undefined, 'not-a-database'])`. |

### tests/integration-smoke.test.ts
| Line | Test | Mark | Evidence |
|---|---|---|---|
| 7 | builds the TS-source integration with Cloudflare and emits injected routes | D | Superseded by stronger checks: (1) scripts/pack-test.ts:237-247 builds two packed consumers and requires every `routeManifest` pattern (all 19, not 6) in the `deserializeManifest(` payload; (2) scripts/smoke-preview-test.ts builds this same smoke site from TS source and serves `/`, availability and assets through `astro preview`; (3) the retired `/webhooks/stripe` negative is covered by route-customization:112 (exact equality with `routeManifest`, so no alias can be injected) and e2e errors.spec.ts:29 (POST returns 404). This test costs ~25 s of `bun run test`. |
| 30 | declares the payment fields and local token key exercised by the workers smoke test | D | Exact source/string greps (junk pattern). The behavior is proven elsewhere: tests/workers/smoke-runtime.test.ts:86-91 (the smoke runtime's `getSession` returns `amountTotal === priceMinor` and the currency), :102-110 (tokens hash, which proves RESERVA_TOKEN_ENC_KEY is readable without `secretBindings` through the real smoke runtime), integration-runtime:77 (the allowlist contract), and the e2e manage flows (the wrangler.jsonc vars key is required for usable manage links under `astro dev`). |

### tests/providers-tree-shake.test.ts
| Line | Test | Mark | Evidence |
|---|---|---|---|
| 101 | declares only CSS as side-effectful so bundlers may drop unused provider exports | R | Packed-package-shape contract. pack-test does not check `sideEffects`, and no bundling check exists. |
| 108 | has at least one narrow provider subpath to guard | R | Anti-vacuity guard for the two `it.each` tables, which enumerate from `package.json` exports rather than a copied list. |
| 112 | %s runs no code at import time (3 rows) | R | Structural source inspection is the cheapest independent guard of the tree-shake contract (README "Other providers"). It survives identifier refactors. |
| 118 | %s does not reach into another provider (3 rows) | R | Same contract: no cross-provider relative import. |

### tests/route-customization.test.ts
| Line | Test | Mark | Evidence |
|---|---|---|---|
| 47 | normalizeRoutePrefix: normalizes %j to %j (8 rows) | R | Owner of pure normalization, including the `''`/`'/'` to no-prefix rows. The `'/en///'` row feeds input that validation (the `//` refine) always rejects first. Harmless. |
| 62 | accepts no options | D | Duplicates the boundary test :112 (setup with no routePrefix injects the default table). `validateRouteOptions` is internal: its one caller is integration.ts:134, and it is not exported from any package entry. |
| 66 | accepts a valid prefix | D | Duplicates the boundary test :118 (`routePrefix: '/en'` mounts every route). |
| 70 | rejects a prefix containing whitespace | D | Exact duplicate of :151 (setup with `'/en service'` throws /whitespace/), which is the stronger boundary. |
| 74 | rejects a prefix containing ".." traversal segments | C | The only test of the `..` refine message. Move it as a row into the setup-level table at :78 (with its message). |
| 78 | rejects URL or network-path syntax in %j (6 rows) | F | Runs through the real setup boundary, but asserts only `toThrow()`. Assert each row's rule-specific message (design law: remediating errors), so a throw from another source cannot pass. |
| 85 | accepts and normalizes safe prefix %j (4 rows) | C | The normalize half duplicates :47 except the `'/en/fr'` row; move that row there. The accept half is covered by :118 and :124. |
| 97 | requireEnabledRoutePath: returns enabled route paths and rejects disabled groups | C | Its only production caller is ManageBooking.astro with `'managePage'`. routes-manage-group.test.ts:91 already pins the throw format and the enabled path at that caller's use. The admin variant and prefix add nothing: prefixed paths are owned by :164. |
| 112 | no options: default injected route patterns are byte-identical to the current 19 | R | Keeper: injected table === `routeManifest` (order included). Absorbs integration-entry:30's `prerender:false` and `existsSync(entrypoint)` assertions. |
| 118 | routePrefix mounts every route under the prefix, in the same order | R | Keeper for prefix mounting. |
| 124 | an unnormalized prefix (no leading slash, trailing slash) still mounts correctly | R | Normalization at the boundary (integration.ts:140). |
| 132 | config.routes: { ops: false } omits every operator route and nothing else | F | Capability gate exercised correctly, but the ops patterns are hand-copied. The list omits `/api/booking/ops/health`, which only the magic `14` covers. Enumerate `routeManifest.filter(e => e.group === 'ops')` and assert the rest equals the non-ops manifest. |
| 144 | config.routes: { admin: false } omits only the admin dashboard route | R | Gate exercised on the injected table. The magic `18` could derive from the manifest (cosmetic). |
| 151 | rejects an invalid routePrefix at setup time, before any route is injected | R | Keeper for prefix rejection at setup. |
| 164 | exposes the validated config and the resolved paths and group flags through virtual:reserva/config | R | `virtual:reserva/config` contract: the single build-time source of config and routes. |
| 175 | marks the route config dev only for astro dev | R | Security: the admin dev bypass must never be on in build or preview output. |
| 183 | renderManagePage uses the resolved (prefixed) manage path everywhere | R | Only prefixed-form-action proof. The route passes `context.routeConfig.paths.managePage` (routes/booking/manage.ts:100). |
| 190 | admin page manage links use the resolved (prefixed) manage path | R | Only prefixed admin-link proof. routes-manage-group covers only the unprefixed case. |
| 210 | a context built without an explicit routeConfig defaults to the unprefixed, all-groups-enabled table | R | `createReservaContext` default. Used by scripts and by consumer `scheduled()` contexts. |
| 231 | createRouteContext overwrites the runtime-provided routeConfig | R | Only test of the route-entrypoint seam (route-context.ts:10). All 19 route files are production callers. |

### tests/runtime-context-types.test.ts
| Line | Test | Mark | Evidence |
|---|---|---|---|
| 39 | threads an explicit TEnv into bindings.env and constrains binding-name options to its keys | R | Compile-time contract enforced by `bun run typecheck`. Pinned by 30015bf and 677c174. |
| 58 | accepts a custom-binding-only Env while preserving keyof binding checks | R | Regression pin from 677c174 (custom Env binding names). |
| 72 | keeps the zero-config path accepting arbitrary binding names | R | Guards the overload split (runtime-context.ts:208-216). |
| 82 (top level, not an `it`) | pickup option label required (`@ts-expect-error`) | R | Regression pin from 160d94b (consumer-upgrade findings). It concerns ClientConfig types, so tests/core-config would be a better home. Optional move. |

## Layer plan

Contracts and their keepers:

| Contract | Keeper | Retire / absorb |
|---|---|---|
| Injected route table === `routeManifest` (source integration) | route-customization:112 (+ absorb `prerender:false`, `existsSync(entrypoint)` from integration-entry:30) | integration-entry:30 (copied list) |
| Built artifact mounts every route | scripts/pack-test.ts `astroBuild` (packed dist, all 19 routes, SSR manifest) | integration-smoke:7 |
| Source-integration build serves traffic | scripts/smoke-preview-test.ts (+ e2e `astro dev`) | integration-smoke:7 |
| Retired `/webhooks/stripe` alias stays gone | e2e errors.spec.ts:29 + route-customization:112 exact equality | integration-smoke:7 negative |
| Dev payment fields and secret readability in the reference consumer | tests/workers/smoke-runtime.test.ts, integration-runtime:77 | integration-smoke:30 |
| Virtual runtime module resolution | component project (the real `reserva()` plugin in vitest.config.ts) + packaged builds | integration-entry:65 |
| Prefix validation and normalization | route-customization boundary tests :78 (with messages), :124, :151; :47 for pure normalization | :62, :66, :70 (D); :74, :85 (C) |
| Disabled-group link fallback (`requireEnabledRoutePath`) | routes-manage-group.test.ts:91 | route-customization:97 |
| Binding guard | integration-runtime:108 as an `it.each` | :116 merged |
| `caches.default` fallback | tests/workers/runtime-workerd.test.ts (new assertion, moved from integration-runtime:102) | integration-runtime:102 |
| Env schema ⇔ runtime secret allowlist | integration-env-schema:36 enumerating from runtime constants | none |
| Webhook route delegation | integration-entry:56 (grep) until a component-project `POST` exercises the route | none yet |
| Tree-shake / `sideEffects` | providers-tree-shake (all) | none |
| Packed package shape / export inventory | scripts/pack-test.ts (`EXPECTED_EXPORT_SUBPATHS` is a deliberate independent inventory, per its comment) | none |

Shared setup: the `astro:config:setup` harness is hand-rolled in integration-entry,
integration-env-schema, route-customization and routes-manage-group. Consolidate it into one
helper in tests/fixtures.ts in the same change that edits these files.

Test-only production seams: none found. Every export the lane's tests import has a non-test
caller or is public: `virtualRuntimeId` and `virtualConfigId` via src/index.ts; `getEnv` and
`getCache` via src/runtime.ts; `normalizeRoutePrefix`, `validateRouteOptions`,
`resolveRouteConfig` and `enabledRouteManifest` via integration.ts; `requireEnabledRoutePath`
via ManageBooking.astro; `createRouteContext` via all route files. Unrelated to the tests, and
dead but harmless: the `export` keywords on `isRouteEnabled`, `ReservaRouteEntry` and
`ReservaRouteOptions` (routes-manifest.ts) have no importer anywhere. Optional cleanup; not
unlocked by any deletion.

## High-confidence batch

### 1. integration-smoke.test.ts:7, "builds the TS-source integration with Cloudflare and emits injected routes" (D)
- Failure detected: a route missing from the built SSR manifest of a TS-source smoke build (6 of 19 routes checked), or the retired `/webhooks/stripe` present.
- Non-test callers: none (the test covers the build pipeline, not a seam).
- Stronger remaining proof: pack-test.ts:237-247 (all 19 `routeManifest` patterns in the packed consumers' `deserializeManifest(` payload); smoke-preview-test.ts (same smoke site, same TS-source integration, built and served); route-customization:112 (exact injected-table equality); e2e errors.spec.ts:29 (`/webhooks/stripe` returns 404).
- History: dates from the initial commit (92129c7), when no packaged checks existed. The packaged CI job was added later and now covers it.
- Deletion unlocked: ~25 s `astro build` out of `bun run test`; the file shrinks to one test (the whole file goes with #2).
- Risk: low. The local `bun run test` loop no longer builds, so build breakage surfaces in `test:preview`/`test:pack` (CI `packaged` job, `bun run check`). Validation: `bun run test:preview && bun run test:pack`.

### 2. integration-smoke.test.ts:30, "declares the payment fields and local token key exercised by the workers smoke test" (D)
- Failure detected: text changes in examples/smoke-site/src/runtime.ts (`devProviders(`, no `secretBindings`), src/dev/index.ts (`amountTotal: session.amountTotal`, `currency: session.currency`) and wrangler.jsonc (`"RESERVA_TOKEN_ENC_KEY"`). Behavior-preserving rewrites also fail it.
- Non-test callers: n/a (greps).
- Stronger remaining proof: tests/workers/smoke-runtime.test.ts:86-91 and :102-110 (the real smoke runtime returns the payment fields and hashes tokens with no `secretBindings`); integration-runtime:77; e2e customer-manage/operator specs (need the wrangler vars key for usable manage links).
- History: 8a7fc5a added the `secretBindings` absence grep; earlier edits were renames. Its stated purpose is to keep the workers smoke test's inputs present, and the workers test itself does that.
- Deletion unlocked: with #1, the whole tests/integration-smoke.test.ts file.
- Risk: low. Validation: `bun run test:workers tests/workers/smoke-runtime.test.ts`.

### 3. integration-entry.test.ts:65, "resolves the virtual module to the explicit user runtime without serializing config" (D)
- Failure detected: `runtimeVirtualPlugin` `resolveId`/`load` breaking; config text appearing in the runtime re-export (impossible by construction).
- Non-test callers: `runtimeVirtualPlugin` runs in every Astro build and in the component project.
- Stronger remaining proof: the component project (vitest.config.ts registers `reserva()`; customer-page-routes and manage-body-limit import routes that resolve `virtual:reserva/runtime`); pack-test and quickstart builds.
- History: from the initial commit (92129c7), when config was passed separately. Config now travels through `virtual:reserva/config` by design (plan item 12), so the "without serializing config" framing is obsolete.
- Deletion unlocked: none in production (`virtualRuntimeId` is public).
- Risk: low. Validation: `bun run test tests/component/customer-page-routes.test.ts` (component project), then `bun run test tests/integration-entry.test.ts`.

### 4. route-customization.test.ts:62, :66, :70 ("accepts no options", "accepts a valid prefix", "rejects a prefix containing whitespace") (D)
- Failure detected: `validateRouteOptions` accept/reject behavior for `{}`, `'/en'` and whitespace.
- Non-test callers: integration.ts:134, its only caller; not exported from any package entry.
- Stronger remaining proof: the boundary tests in the same file, :112 (no options), :118 (`'/en'` mounts), :151 (whitespace rejected at setup with /whitespace/).
- History: added with the route-prefix feature. These are unit restatements of a helper whose boundary tests landed alongside them.
- Deletion unlocked: none (the helper stays; the integration uses it).
- Risk: very low. Validation: `bun run test tests/route-customization.test.ts`.

### 5. route-customization.test.ts:97, "requireEnabledRoutePath returns enabled route paths and rejects disabled groups" (C, absorbed; no new assertion needed)
- Failure detected: the error-message format and the enabled path for the admin group under `/en`.
- Non-test callers: ManageBooking.astro (the `managePage` id only).
- Stronger remaining proof: routes-manage-group.test.ts:91 (the same function, the production id, the same message shape); prefixed paths are covered by route-customization:164.
- History: route-prefix feature; the manage-group test (cacb9fa) later added the caller-accurate case.
- Deletion unlocked: none.
- Risk: low. Validation: `bun run test tests/routes-manage-group.test.ts tests/route-customization.test.ts`, one file at a time.

Next batch (medium confidence, needs an edit rather than a pure delete): integration-entry:30 → carry
into route-customization:112; route-customization:74 and :85 → table rows; integration-runtime:116 → `it.each`
with :108; F repairs on integration-env-schema:36, integration-runtime:102, route-customization:78 and :132.

## Suspected product bugs

None confirmed. Observations:
- integration.ts:39-43 hardcodes the three secret names separately from the runtime constants
  (context.ts, admin-csrf.ts, repo.ts). No drift today, but nothing ties the two lists together. The F on
  integration-env-schema:36 closes that gap without importing runtime modules into the build-time integration.
- integration-runtime:102's name promises the `caches.default` fallback, but no suite exercises it.
