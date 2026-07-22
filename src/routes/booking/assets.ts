import { themeCss } from '../../ui/theme';

export const prerender = false;

// The stylesheet ships from a route (not an inline <style>) so bookkit's server-rendered pages
// stay compatible with strict CSP: consumers only need style-src 'self'. Immutable is safe because
// pages link it through cssAssetHref's content-versioned URL (see ui/asset-hrefs.ts).
export function GET(): Response {
  return new Response(themeCss, {
    status: 200,
    headers: {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
