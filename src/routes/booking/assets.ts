import { themeCss } from '../../ui/theme.js';

export const prerender = false;

// Ships from a route (not inline <style>) so pages stay compatible with strict CSP: consumers
// only need style-src 'self'. Immutable is safe because pages link it via a content-versioned URL.
export function GET(): Response {
  return new Response(themeCss, {
    status: 200,
    headers: {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
