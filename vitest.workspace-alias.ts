import { fileURLToPath } from 'node:url';

// Specifiers resolve to source, not a built dist/, so tests compile the same files as everything
// else. Exact-match patterns — a bare prefix would swallow subpaths like `/core`.
export const workspaceAlias = [
  { find: /^@reservajs\/astro$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
  { find: /^@reservajs\/astro\/core$/, replacement: fileURLToPath(new URL('./src/core/index.ts', import.meta.url)) },
  { find: /^@reservajs\/astro\/runtime$/, replacement: fileURLToPath(new URL('./src/runtime.ts', import.meta.url)) },
  { find: /^@reservajs\/astro\/email$/, replacement: fileURLToPath(new URL('./src/email/index.ts', import.meta.url)) },
  { find: /^@reservajs\/stripe$/, replacement: fileURLToPath(new URL('./packages/stripe/src/index.ts', import.meta.url)) },
];
