import type { APIContext } from 'astro';
import { callyBundleJs } from '../../ui/vendor/cally-bundle.js';
import { manageEnhancerJs } from '../../ui/manage-enhancer.js';
import { confirmationEnhancerJs } from '../../ui/confirmation-enhancer.js';
import { adminEnhancerJs } from '../../ui/admin-enhancer.js';
import { settingsEnhancerJs } from '../../ui/settings-enhancer.js';
import { partnersEnhancerJs } from '../../ui/partners-enhancer.js';
import { themeToggleJs } from '../../ui/theme-toggle.js';
import { assetCacheControl, bundleJsVersion } from '../../ui/asset-hrefs.js';

export const prerender = false;

// Server-rendered pages can't rely on the consumer's bundler, so the calendar web component (cally,
// vendored self-contained ESM) plus the manage-page, confirmation-page and admin enhancers ship as
// one first-party module, loadable under script-src 'self' with no inline scripts.
export function GET({ url }: Pick<APIContext, 'url'>): Response {
  return new Response(`${callyBundleJs}\n${manageEnhancerJs}\n${confirmationEnhancerJs}\n${adminEnhancerJs}\n${settingsEnhancerJs}\n${partnersEnhancerJs}\n${themeToggleJs}`, {
    status: 200,
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': assetCacheControl(url, bundleJsVersion),
    },
  });
}
