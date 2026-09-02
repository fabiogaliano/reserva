import { callyBundleJs } from '../../ui/vendor/cally-bundle.js';
import { manageEnhancerJs } from '../../ui/manage-enhancer.js';
import { adminEnhancerJs } from '../../ui/admin-enhancer.js';
import { settingsEnhancerJs } from '../../ui/settings-enhancer.js';
import { themeToggleJs } from '../../ui/theme-toggle.js';

export const prerender = false;

// Server-rendered pages can't rely on the consumer's bundler, so the calendar web component (cally,
// vendored self-contained ESM) plus the manage-page and admin enhancers ship as one first-party
// module, loadable under script-src 'self' with no inline scripts.
export function GET(): Response {
  return new Response(`${callyBundleJs}\n${manageEnhancerJs}\n${adminEnhancerJs}\n${settingsEnhancerJs}\n${themeToggleJs}`, {
    status: 200,
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
