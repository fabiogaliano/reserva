import { themeCss } from './theme.js';
import { manageEnhancerJs } from './manage-enhancer.js';
import { adminEnhancerJs } from './admin-enhancer.js';
import { settingsEnhancerJs } from './settings-enhancer.js';
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
export const bundleJsVersion = contentVersion(callyBundleJs + manageEnhancerJs + adminEnhancerJs + settingsEnhancerJs + themeToggleJs);

export function cssAssetHref(assetsCssPath: string): string {
  return `${assetsCssPath}?v=${themeCssVersion}`;
}

export function jsAssetHref(assetsJsPath: string): string {
  return `${assetsJsPath}?v=${bundleJsVersion}`;
}
