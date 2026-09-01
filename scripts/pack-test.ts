// Verifies the *published artifact*, not the repository: everything else (unit tests, workers
// tests, the smoke-site build, e2e) exercises `../../src/index.ts` or a spawned repo-root script
// directly, so a `files`/`exports`/`bin` mistake in package.json would ship silently (plan 010).
//
// This packs the real tarball (`bun pm pack`), installs it into a throwaway copy of
// `tests/pack-fixture/` outside the repo (so nothing here can leak in via hoisted node_modules or
// a shared lockfile), then proves every subpath a consumer can reach actually resolves, typechecks,
// builds, and runs the way README.md documents:
//   1. every non-`.astro` `exports` subpath resolves and typechecks under `tsc --noEmit`
//   2. every `.astro` export resolves and compiles under `astro build` (plain tsc can't parse it)
//   3. `astro build` succeeds and every injected route pattern appears in the built worker
//   4. the installed `bookkit-migrate` bin applies bookkit's packaged migrations (plan 008)
//
// Run: `bun run test:pack` (also folded into `bun run verify` and CI's `pack` job).

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOKKIT_MIGRATIONS } from '../src/migrations-manifest';
import { routeManifest } from '../src/routes-manifest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = resolve(repoRoot, 'tests/pack-fixture');

class PhaseFailure extends Error {}

function fail(phase: string, message: string): never {
  throw new PhaseFailure(`pack-test: [${phase}] ${message}`);
}

function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  return spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, encoding: 'utf8' });
}

// `--destination` (not the default cwd) so the tarball never lands inside the repo tree.
function packTarball(destination: string): string {
  const result = run('bun', ['pm', 'pack', '--quiet', '--destination', destination], { cwd: repoRoot });
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
function bunAddTarball(consumerDir: string, tarballPath: string): void {
  const result = run('bun', ['add', tarballPath], { cwd: consumerDir });
  if (result.status !== 0) fail('install', `\`bun add ${tarballPath}\` failed:\n${result.stdout}\n${result.stderr}`);
}

interface PackageJsonExports {
  exports: Record<string, string>;
}

// This inventory is intentionally independent of package.json: deriving the test only from the
// live map would let an accidentally deleted public subpath disappear from the test as well.
const EXPECTED_EXPORT_SUBPATHS = [
  '.',
  './core',
  './providers',
  './providers/calendar-google',
  './providers/payments-stripe',
  './providers/email-brevo',
  './providers/email-none',
  './runtime',
  './components/BookingWidget.astro',
  './components/ManageBooking.astro',
  './components/AdminDashboard.astro',
] as const;

function writeImportAll(consumerDir: string): string[] {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as PackageJsonExports;
  const actualSubpaths = Object.keys(packageJson.exports);
  const missing = EXPECTED_EXPORT_SUBPATHS.filter((subpath) => !actualSubpaths.includes(subpath));
  const unexpected = actualSubpaths.filter((subpath) => !EXPECTED_EXPORT_SUBPATHS.includes(subpath as typeof EXPECTED_EXPORT_SUBPATHS[number]));
  if (missing.length > 0 || unexpected.length > 0) {
    fail('exports', `public export inventory changed; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`);
  }

  // `.astro` subpaths are proven by the fixture's pages and astro build; tsc cannot parse them.
  const subpaths = Object.entries(packageJson.exports)
    .filter(([, target]) => !target.endsWith('.astro'))
    .map(([subpath]) => (subpath === '.' ? '@reservajs/astro' : `@reservajs/astro${subpath.slice(1)}`));
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

function astroBuild(consumerDir: string): void {
  const result = run('bunx', ['astro', 'build'], { cwd: consumerDir });
  if (result.status !== 0) fail('build', `\`astro build\` failed:\n${result.stdout}\n${result.stderr}`);

  const entryPath = resolve(consumerDir, 'dist/server/entry.mjs');
  if (!existsSync(entryPath)) fail('build', `expected server build output missing: ${entryPath}`);
  const entry = readFileSync(entryPath, 'utf8');
  for (const route of routeManifest) {
    if (!entry.includes(route.pattern)) fail('build', `injected route \`${route.pattern}\` (${route.id}) is missing from the built worker entry (${entryPath})`);
  }
}

// Pins plan 008: an installed consumer with no `migrations_dir` must still get bookkit's packaged
// migrations applied, via the `bookkit-migrate` bin resolved from node_modules/.bin.
function bookkitMigrate(consumerDir: string): void {
  const binDir = resolve(consumerDir, 'node_modules/.bin');
  const result = run('bunx', ['bookkit-migrate', '--local'], {
    cwd: consumerDir,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
  });
  if (result.status !== 0) fail('migrate', `\`bunx bookkit-migrate --local\` failed:\n${result.stdout}\n${result.stderr}`);
  for (const name of BOOKKIT_MIGRATIONS) {
    if (!result.stdout.includes(name)) fail('migrate', `expected migration \`${name}\` was not applied; wrangler output:\n${result.stdout}`);
  }
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(resolve(tmpdir(), 'bookkit-pack-'));
  const consumerDir = resolve(workDir, 'consumer');
  try {
    console.log(`pack-test: packing tarball into ${workDir}`);
    const tarballPath = packTarball(workDir);
    console.log(`pack-test: packed ${tarballPath}`);

    console.log(`pack-test: copying tests/pack-fixture into ${consumerDir}`);
    cpSync(fixtureDir, consumerDir, { recursive: true });

    console.log('pack-test: bun install (fixture devDependencies)');
    bunInstall(consumerDir);

    console.log('pack-test: bun add <tarball> (installs bookkit the way a real consumer would)');
    bunAddTarball(consumerDir, tarballPath);

    console.log('pack-test: asserting the scheduled Worker template is included');
    assertScheduledTemplatePackaged(consumerDir);

    console.log('pack-test: typechecking every non-.astro exports subpath and the production-like provider factory');
    const subpaths = writeImportAll(consumerDir);
    typecheck(consumerDir, subpaths);

    console.log('pack-test: building the packed consumer scheduled Worker');
    scheduledWorkerBuild(consumerDir);

    console.log('pack-test: astro build (compiles .astro exports, mounts injected routes)');
    astroBuild(consumerDir);

    console.log('pack-test: bunx bookkit-migrate --local (packaged migrations, plan 008)');
    bookkitMigrate(consumerDir);

    console.log('pack-test: OK');
  } catch (error) {
    if (error instanceof PhaseFailure) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    if (process.env.BOOKKIT_PACK_TEST_KEEP) {
      console.log(`pack-test: BOOKKIT_PACK_TEST_KEEP set, leaving ${workDir}`);
    } else {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

void main();
