import type { APIContext } from 'astro';
import virtualConfig from 'virtual:reserva/config';
import { assetCacheControl, cssAssetVersion } from '../../ui/asset-hrefs.js';
import { brandingCss } from '../../ui/branding.js';
import { themeCss } from '../../ui/theme.js';

export const prerender = false;

// Ships from a route (not inline <style>) so pages stay compatible with strict CSP: consumers
// only need style-src 'self'. Immutable only under the content-versioned URL the pages link to.
const branding = virtualConfig.config.ui?.branding;
const stylesheet = themeCss + brandingCss(branding);
const version = cssAssetVersion(branding);

export function GET({ url }: Pick<APIContext, 'url'>): Response {
  return new Response(stylesheet, {
    status: 200,
    headers: {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': assetCacheControl(url, version),
    },
  });
}
