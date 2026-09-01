import { fileURLToPath } from 'node:url';

// In this repo the published specifiers resolve to sources, not to a built dist/: workspace code
// (packages/stripe) and the tests that assemble it with the library must compile the same files
// every other test does. Exact-match patterns — a bare prefix would swallow the subpaths.
export const workspaceAlias = [
  { find: /^@reservajs\/astro$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
  { find: /^@reservajs\/astro\/core$/, replacement: fileURLToPath(new URL('./src/core/index.ts', import.meta.url)) },
  { find: /^@reservajs\/astro\/runtime$/, replacement: fileURLToPath(new URL('./src/runtime.ts', import.meta.url)) },
  { find: /^@reservajs\/astro\/email$/, replacement: fileURLToPath(new URL('./src/email/index.ts', import.meta.url)) },
  { find: /^@reservajs\/stripe$/, replacement: fileURLToPath(new URL('./packages/stripe/src/index.ts', import.meta.url)) },
];
