// Verifies the *published artifact*, not the repository: everything else (unit tests, workers
// tests, the smoke-site build, e2e) exercises `../../src/index.ts` or a spawned repo-root script
// directly, so a `files`/`exports`/`bin` mistake in package.json would ship silently.
//
// This packs the real tarball (`bun pm pack`), installs it into a throwaway copy of
// `tests/pack-fixture/` outside the repo (so nothing here can leak in via hoisted node_modules or
// a shared lockfile), then proves every subpath a consumer can reach actually resolves, typechecks,
// builds, and runs the way README.md documents:
//   1. every non-`.astro` `exports` subpath resolves and typechecks under `tsc --noEmit`
//   2. every `.astro` export resolves and compiles under `astro build` (plain tsc can't parse it)
//   3. `astro build` succeeds and every injected route pattern appears in the built worker
//   4. the installed `reserva-migrate` bin applies reserva's packaged migrations
//
// Two consumers are built from one shared fixture base: `core-only` installs @reservajs/astro
// alone and pays through a provider it wrote itself, with the `stripe` SDK absent from its
// node_modules entirely; `with-stripe` installs both tarballs and wires the official adapter's
// `stripe(options)` factory.
//
// Run: `bun run test:pack` (also folded into `bun run verify` and CI's `pack` job).

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESERVA_MIGRATIONS } from '../src/migrations-manifest';
import { routeManifest } from '../src/routes-manifest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureBaseDir = resolve(repoRoot, 'tests/pack-fixture/base');
const fixtureConsumersDir = resolve(repoRoot, 'tests/pack-fixture/consumers');
const stripePackageDir = resolve(repoRoot, 'packages/stripe');

class PhaseFailure extends Error {}

function fail(phase: string, message: string): never {
  throw new PhaseFailure(`pack-test: [${phase}] ${message}`);
}

function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  return spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, encoding: 'utf8' });
}

// Explicit, not relying on whichever lifecycle hooks the packing tool happens to honour: the
// tarball must contain a dist/ built from the tree under test, never a stale one.
function buildDist(): void {
  const astro = run('bun', ['run', 'build'], { cwd: repoRoot });
  if (astro.status !== 0) fail('build', `\`bun run build\` failed:\n${astro.stdout}\n${astro.stderr}`);
  const adapter = run('bun', ['run', '--filter', '@reservajs/stripe', 'build'], { cwd: repoRoot });
  if (adapter.status !== 0) fail('build', `\`bun run --filter @reservajs/stripe build\` failed:\n${adapter.stdout}\n${adapter.stderr}`);
}

// `--destination` (not the default cwd) so the tarball never lands inside the repo tree.
function packTarball(packageDir: string, destination: string): string {
  const result = run('bun', ['pm', 'pack', '--quiet', '--destination', destination], { cwd: packageDir });
  if (result.status !== 0) fail('pack', `\`bun pm pack\` failed:\n${result.stderr}`);
  // `--quiet` can still print a leading blank line before the path (observed with bun 1.2.23); the
  // tarball path is the last non-empty stdout line, not necessarily the whole trimmed output.
  const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const tarballPath = lines.at(-1);
  if (!tarballPath || !existsSync(tarballPath)) fail('pack', `could not determine the packed tarball path from output:\n${result.stdout}`);
  return tarballPath;
}

function bunInstall(consumerDir: string): void {
  const result = run('bun', ['install'], { cwd: consumerDir });
  if (result.status !== 0) fail('install', `\`bun install\` in the consumer fixture failed:\n${result.stdout}\n${result.stderr}`);
}

// Real consumer flow: `bun add <tarball path>`, not a workspace/link — proves the tarball is a
// self-sufficient installable unit, not something that only works via this repo's own node_modules.
// Until release day @reservajs/astro does not exist on the registry, and bun resolves an installed
// package's peerDependencies against the registry rather than against what the very same command
// just installed — so adding the adapter tarball reports a 404 for its peer even though both
// packages land correctly. Tolerate exactly that one error, and prove the outcome on disk instead
// of trusting the exit code; once the package is published the install is clean and this branch
// stops being taken.
const UNPUBLISHED_PEER_ERROR = 'https://registry.npmjs.org/@reservajs%2fastro - 404';

function bunAddTarballs(consumerDir: string, tarballPaths: string[], expectInstalled: string[]): void {
  const result = run('bun', ['add', ...tarballPaths], { cwd: consumerDir });
  if (result.status === 0) return;
  const output = `${result.stdout}\n${result.stderr}`;
  const installed = expectInstalled.every((name) => existsSync(resolve(consumerDir, 'node_modules', name, 'package.json')));
  if (!output.includes(UNPUBLISHED_PEER_ERROR) || !installed) {
    fail('install', `\`bun add ${tarballPaths.join(' ')}\` failed:\n${output}`);
  }
}

// `.astro` subpaths point straight at the copied raw file; every compiled subpath carries the
// types/default condition pair.
type ExportTarget = string | { types: string; default: string };

interface PackageJsonExports {
  exports: Record<string, ExportTarget>;
}

// This inventory is intentionally independent of package.json: deriving the test only from the
// live map would let an accidentally deleted public subpath disappear from the test as well.
const EXPECTED_EXPORT_SUBPATHS = [
  '.',
  './core',
  './email',
  './providers',
  './providers/calendar-google',
  './providers/email-brevo',
  './providers/email-none',
  './runtime',
  './ui',
  './components/ManageBooking.astro',
  './components/AdminDashboard.astro',
] as const;

function writeImportAll(consumerDir: string, extraSpecifiers: string[]): string[] {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as PackageJsonExports;
  const actualSubpaths = Object.keys(packageJson.exports);
  const missing = EXPECTED_EXPORT_SUBPATHS.filter((subpath) => !actualSubpaths.includes(subpath));
  const unexpected = actualSubpaths.filter((subpath) => !EXPECTED_EXPORT_SUBPATHS.includes(subpath as typeof EXPECTED_EXPORT_SUBPATHS[number]));
  if (missing.length > 0 || unexpected.length > 0) {
    fail('exports', `public export inventory changed; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`);
  }

  // `.astro` subpaths are proven by the fixture's pages and astro build; tsc cannot parse them.
  const subpaths = Object.entries(packageJson.exports)
    .filter(([, target]) => typeof target !== 'string')
    .map(([subpath]) => (subpath === '.' ? '@reservajs/astro' : `@reservajs/astro${subpath.slice(1)}`))
    .concat(extraSpecifiers);
  const imports = subpaths.map((specifier, index) => `import * as mod${index} from ${JSON.stringify(specifier)};`).join('\n');
  const usage = `export const importedSubpaths: unknown[] = [${subpaths.map((_, index) => `mod${index}`).join(', ')}];\n`;
  writeFileSync(resolve(consumerDir, 'import-all.generated.ts'), `${imports}\n\n${usage}`);
  return subpaths;
}

function assertScheduledTemplatePackaged(consumerDir: string): void {
  for (const relativePath of [
    'examples/smoke-site/worker/scheduled.ts',
    'examples/smoke-site/worker/wrangler.jsonc',
  ]) {
    const installedPath = resolve(consumerDir, 'node_modules/@reservajs/astro', relativePath);
    if (!existsSync(installedPath)) fail('template', `scheduled Worker template file missing from packed package: ${relativePath}`);
  }
}

// dist/ is the whole artifact: the raw `.astro` components and the CSS their relative imports
// reach must sit inside it, mirroring their source layout, and no TypeScript source may ship
// beside it — a consumer compiling our sources is exactly what the build removes.
function assertPackagedLayout(consumerDir: string): void {
  const installedRoot = resolve(consumerDir, 'node_modules/@reservajs/astro');
  for (const relativePath of [
    'dist/index.js',
    'dist/index.d.ts',
    'dist/reserva-migrate.js',
    'dist/components/ManageBooking.astro',
    'dist/components/AdminDashboard.astro',
    'dist/ui/components.css',
  ]) {
    if (!existsSync(resolve(installedRoot, relativePath))) fail('layout', `missing from packed package: ${relativePath}`);
  }
  if (existsSync(resolve(installedRoot, 'src'))) fail('layout', 'the packed package still ships src/');

  // The package boundary, asserted on the artifact a consumer actually installs.
  const manifest = JSON.parse(readFileSync(resolve(installedRoot, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
  if (manifest.bin?.['reserva-migrate'] !== 'dist/reserva-migrate.js') {
    fail('layout', 'reserva-migrate must target the compiled executable npm accepts');
  }
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (manifest[field]?.stripe) fail('layout', `@reservajs/astro declares stripe in ${field}`);
  }
}

// The adapter tarball carries its compiled surface and nothing else — no sources, no tests, no
// fixture leftovers.
function assertAdapterPackagedLayout(consumerDir: string): void {
  const installedRoot = resolve(consumerDir, 'node_modules/@reservajs/stripe');
  for (const relativePath of ['dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE']) {
    if (!existsSync(resolve(installedRoot, relativePath))) fail('layout', `missing from packed @reservajs/stripe: ${relativePath}`);
  }
  const unexpected = readdirSync(installedRoot).filter((entry) => !['dist', 'README.md', 'LICENSE', 'package.json', 'node_modules'].includes(entry));
  if (unexpected.length > 0) fail('layout', `unexpected entries in packed @reservajs/stripe: ${unexpected.join(', ')}`);
}

// The core-only consumer proves the SDK is genuinely gone: a stripe/ directory in its node_modules
// would mean something in the dependency graph still pulls it.
function assertStripeAbsent(consumerDir: string): void {
  if (existsSync(resolve(consumerDir, 'node_modules/stripe'))) {
    fail('layout', 'the core-only consumer installed the stripe SDK; @reservajs/astro must not depend on it');
  }
}

function typecheck(consumerDir: string, subpaths: string[]): void {
  const result = run('bunx', ['tsc', '--noEmit'], { cwd: consumerDir });
  if (result.status !== 0) {
    const firstError = result.stdout.split('\n').find((line) => line.includes('error TS')) ?? result.stdout.trim();
    fail(
      'typecheck',
      `\`tsc --noEmit\` failed against the packed tarball.\nSubpaths under test: ${subpaths.join(', ')}\nFirst error: ${firstError}\n\nFull output:\n${result.stdout}`,
    );
  }
}

// `astro build` both compiles the `.astro` exports (via the fixture's own pages, one per exported
// component) and proves the injected routes are actually mounted — the built worker entry contains
// every enabled route's pattern.
function scheduledWorkerBuild(consumerDir: string): void {
  const result = run('bunx', ['wrangler', 'deploy', '--dry-run', '--config', 'wrangler.scheduled.jsonc', '--outdir', 'dist-scheduled'], { cwd: consumerDir });
  if (result.status !== 0) fail('scheduled-build', `packed consumer scheduled Worker build failed:\n${result.stdout}\n${result.stderr}`);
}

function findMjsFilesRecursive(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const entryPath = join(dir, entry);
    if (statSync(entryPath).isDirectory()) {
      files.push(...findMjsFilesRecursive(entryPath));
    } else if (entryPath.endsWith('.mjs')) {
      files.push(entryPath);
    }
  }
  return files;
}

function astroBuild(consumerDir: string): void {
  const result = run('bunx', ['astro', 'build'], { cwd: consumerDir });
  if (result.status !== 0) fail('build', `\`astro build\` failed:\n${result.stdout}\n${result.stderr}`);

  const entryPath = resolve(consumerDir, 'dist/server/entry.mjs');
  if (!existsSync(entryPath)) fail('build', `expected server build output missing: ${entryPath}`);

  // Which `.mjs` file under dist/server carries the serialized SSR manifest is a bundler-layout
  // detail, not part of the contract: under rolldown >= 1.2 the manifest is hoisted out of
  // entry.mjs into a shared chunk (e.g. chunks/entrypoints_<hash>.mjs), while other bundlers inline
  // it into entry.mjs itself. Find whichever file actually calls `deserializeManifest(` — that's
  // the real injection payload — instead of assuming a fixed file layout.
  const serverDir = resolve(consumerDir, 'dist/server');
  const mjsFiles = findMjsFilesRecursive(serverDir);
  const manifestFiles = mjsFiles
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
    .filter(({ text }) => text.includes('deserializeManifest('));
  if (manifestFiles.length === 0) {
    fail(
      'build',
      `could not find the serialized SSR manifest: no \`.mjs\` file under ${serverDir} calls \`deserializeManifest(\`; ` +
        `checked ${mjsFiles.length} file(s): ${mjsFiles.join(', ')}`,
    );
  }

  // Assert the manifest's JSON field form, not a whole-dist grep: the compiled
  // `virtual:reserva/config` chunk (chunks/config_*.mjs) contains every route path regardless of
  // whether it was actually injected, so a tree-wide grep would false-pass a missing route. The
  // `deserializeManifest(` payload is the injection truth, and this form matches the old inlined
  // layout too, so it's layout-independent and strictly stronger than the old check.
  for (const route of routeManifest) {
    const needle = `"route":"${route.pattern}"`;
    const found = manifestFiles.some(({ text }) => text.includes(needle));
    if (!found) {
      fail(
        'build',
        `injected route \`${route.pattern}\` (${route.id}) is missing from the serialized SSR manifest ` +
          `(checked ${manifestFiles.map(({ path }) => path).join(', ')})`,
      );
    }
  }
}

// An installed consumer with no `migrations_dir` must still get reserva's packaged migrations
// applied, via the `reserva-migrate` bin resolved from node_modules/.bin.
function reservaMigrate(consumerDir: string): void {
  const binDir = resolve(consumerDir, 'node_modules/.bin');
  const result = run('bunx', ['reserva-migrate', '--local'], {
    cwd: consumerDir,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
  });
  if (result.status !== 0) fail('migrate', `\`bunx reserva-migrate --local\` failed:\n${result.stdout}\n${result.stderr}`);
  for (const name of RESERVA_MIGRATIONS) {
    if (!result.stdout.includes(name)) fail('migrate', `expected migration \`${name}\` was not applied; wrangler output:\n${result.stdout}`);
  }
}

interface ConsumerSpec {
  name: string;
  tarballs: string[];
  expectInstalled: string[];
  extraImports: string[];
  expectStripeAbsent: boolean;
}

function buildConsumer(workDir: string, spec: ConsumerSpec): void {
  const consumerDir = resolve(workDir, spec.name);
  console.log(`pack-test: [${spec.name}] assembling consumer in ${consumerDir}`);
  cpSync(fixtureBaseDir, consumerDir, { recursive: true });
  cpSync(resolve(fixtureConsumersDir, spec.name), consumerDir, { recursive: true });

  console.log(`pack-test: [${spec.name}] bun install (fixture devDependencies)`);
  bunInstall(consumerDir);

  console.log(`pack-test: [${spec.name}] bun add ${spec.tarballs.length} tarball(s), the way a real consumer would`);
  bunAddTarballs(consumerDir, spec.tarballs, spec.expectInstalled);

  console.log(`pack-test: [${spec.name}] asserting the packed layout`);
  assertScheduledTemplatePackaged(consumerDir);
  assertPackagedLayout(consumerDir);
  if (spec.expectStripeAbsent) assertStripeAbsent(consumerDir);
  else assertAdapterPackagedLayout(consumerDir);

  console.log(`pack-test: [${spec.name}] typechecking every subpath and the production-like provider factory`);
  const subpaths = writeImportAll(consumerDir, spec.extraImports);
  typecheck(consumerDir, subpaths);

  console.log(`pack-test: [${spec.name}] building the packed consumer scheduled Worker`);
  scheduledWorkerBuild(consumerDir);

  console.log(`pack-test: [${spec.name}] astro build (compiles .astro exports, mounts injected routes)`);
  astroBuild(consumerDir);

  console.log(`pack-test: [${spec.name}] bunx reserva-migrate --local (packaged migrations, plan 008)`);
  reservaMigrate(consumerDir);
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(resolve(tmpdir(), 'reserva-pack-'));
  try {
    console.log('pack-test: building both packages');
    buildDist();

    console.log(`pack-test: packing tarballs into ${workDir}`);
    const astroTarball = packTarball(repoRoot, workDir);
    const stripeTarball = packTarball(stripePackageDir, workDir);
    console.log(`pack-test: packed ${astroTarball} and ${stripeTarball}`);

    buildConsumer(workDir, {
      name: 'core-only',
      tarballs: [astroTarball],
      expectInstalled: ['@reservajs/astro'],
      extraImports: [],
      expectStripeAbsent: true,
    });
    buildConsumer(workDir, {
      name: 'with-stripe',
      tarballs: [astroTarball, stripeTarball],
      expectInstalled: ['@reservajs/astro', '@reservajs/stripe'],
      extraImports: ['@reservajs/stripe'],
      expectStripeAbsent: false,
    });

    console.log('pack-test: OK');
  } catch (error) {
    if (error instanceof PhaseFailure) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    if (process.env.RESERVA_PACK_TEST_KEEP) {
      console.log(`pack-test: RESERVA_PACK_TEST_KEEP set, leaving ${workDir}`);
    } else {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

void main();
