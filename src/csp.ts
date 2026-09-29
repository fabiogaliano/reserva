import type { ResolvedClientConfig } from './core/config.js';

// Every page Reserva renders loads only its own stylesheet, module script and same-origin images,
// and posts forms back to itself, so nothing else is allowed. data: covers the inline SVG icons
// some browsers fetch as images.
export const DEFAULT_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

export function contentSecurityPolicyHeaders(config: Pick<ResolvedClientConfig, 'ui'>): Record<string, string> {
  const policy = config.ui?.contentSecurityPolicy;
  if (policy === false) return {};
  return { 'content-security-policy': policy ?? DEFAULT_CONTENT_SECURITY_POLICY };
}
