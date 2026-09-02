// The public `@reservajs/astro/email` seam: only the default template and the types needed to
// write or wrap a renderer. Catalogs, the HTML model builder, and branding defaults stay
// internal — an external transport author gets the maintained template, not the machinery
// that builds it.
export { renderDefaultEmail } from './render.js';
export type { EmailRenderer, EmailTemplateContext, RenderedEmail } from './render.js';
