import { callyBundleJs } from '../../ui/vendor/cally-bundle';
import { manageEnhancerJs } from '../../ui/manage-enhancer';
import { adminEnhancerJs } from '../../ui/admin-enhancer';
import { settingsEnhancerJs } from '../../ui/settings-enhancer';
import { themeToggleJs } from '../../ui/theme-toggle';

export const prerender = false;

// Like the assetsCss route: bookkit's server-rendered pages can't rely on the consumer's bundler,
// so the calendar web component (cally, vendored self-contained ESM — see scripts/vendor-cally.ts)
// plus the manage-page and admin enhancers are served as one first-party module — loadable under
// script-src 'self' with no inline scripts. Each enhancer no-ops on pages missing its markup.
export function GET(): Response {
  return new Response(`${callyBundleJs}\n${manageEnhancerJs}\n${adminEnhancerJs}\n${settingsEnhancerJs}\n${themeToggleJs}`, {
    status: 200,
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
