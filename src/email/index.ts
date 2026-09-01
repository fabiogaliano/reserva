// The public `@reservajs/astro/email` seam. Deliberately narrow:
// only the default template and the types needed to write or wrap a renderer. Catalogs, the HTML
// model builder, primitives, and branding defaults stay internal to src/email/render.ts and
// src/email/copy.ts — an external transport author gets the maintained template and the shape to
// implement a custom one, not the machinery that builds it.
export { renderDefaultEmail } from './render.js';
export type { EmailRenderer, EmailTemplateContext, RenderedEmail } from './render.js';
