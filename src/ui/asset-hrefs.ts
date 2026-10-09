import { brandingCss, type PageBranding } from './branding.js';
import { themeCss } from './theme.js';
import { manageEnhancerJs } from './manage-enhancer.js';
import { confirmationEnhancerJs } from './confirmation-enhancer.js';
import { adminEnhancerJs } from './admin-enhancer.js';
import { settingsEnhancerJs } from './settings-enhancer.js';
import { partnersEnhancerJs } from './partners-enhancer.js';
import { themeToggleJs } from './theme-toggle.js';
import { callyBundleJs } from './vendor/cally-bundle.js';

// Content-derived version in the query string: any CSS/JS change produces a new URL, so asset
// routes can serve long-lived immutable cache headers without ever showing stale styles.
function contentVersion(source: string): string {
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

export const themeCssVersion = contentVersion(themeCss);
export const bundleJsVersion = contentVersion(callyBundleJs + manageEnhancerJs + confirmationEnhancerJs + adminEnhancerJs + settingsEnhancerJs + partnersEnhancerJs + themeToggleJs);

// The branding rules are appended to the served sheet, so they version it too; an unbranded
// deployment keeps exactly the URL it had.
export function cssAssetVersion(branding?: PageBranding): string {
  const extra = brandingCss(branding);
  return `${themeCssVersion}${extra ? `-${contentVersion(extra)}` : ''}`;
}

export function cssAssetHref(assetsCssPath: string, branding?: PageBranding): string {
  return `${assetsCssPath}?v=${cssAssetVersion(branding)}`;
}

export function jsAssetHref(assetsJsPath: string): string {
  return `${assetsJsPath}?v=${bundleJsVersion}`;
}

// Only the exact URL the pages link to may be cached for a year. Any other `v` — a page cached
// from before a deploy, a hand-typed URL, a guessed future version — would otherwise have
// whatever bytes it received pinned under that key, the very staleness the version exists to rule out.
export function assetCacheControl(url: URL, currentVersion: string): string {
  return url.searchParams.get('v') === currentVersion ? 'public, max-age=31536000, immutable' : 'no-store';
}
