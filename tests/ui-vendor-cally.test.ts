import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callyVersion } from '../src/ui/vendor/cally-bundle';

// cally-bundle.ts is generated (scripts/vendor-cally.ts), never hand-edited, and stamps the cally
// version it was generated from -- the only guard against a `cally` bump shipping a stale bundle.
function installedCallyVersion(): string {
  try {
    // cally's exports map may not expose "./package.json" — prefer require() when it does, since
    // it respects the same resolution the rest of the module graph uses.
    return (createRequire(import.meta.url)('cally/package.json') as { version: string }).version;
  } catch {
    const packageJsonPath = resolve(import.meta.dirname, '..', 'node_modules/cally/package.json');
    return (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string }).version;
  }
}

describe('vendored cally bundle', () => {
  it('matches the installed cally dependency version', () => {
    expect(callyVersion, 'src/ui/vendor/cally-bundle.ts is stale — run `bun scripts/vendor-cally.ts` to re-vendor it against the installed cally version').toBe(installedCallyVersion());
  });
});
