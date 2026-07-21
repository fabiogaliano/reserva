import { defineAction } from 'astro:actions';
import { z } from 'astro/zod';
import runtime from 'virtual:bookkit/runtime';
import { handleCheckout } from './handlers';

export const checkoutInput = z.object({
  tourSlug: z.string().min(1),
  start: z.string().min(1),
  people: z.number().int().positive(),
  pickupType: z.enum(['default', 'custom']),
  locale: z.string().min(1),
});

export const checkout = defineAction({
  input: checkoutInput,
  async handler(input, actionContext) {
    const request = new Request(new URL('/api/booking/checkout', actionContext.request.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const response = await handleCheckout(request, await runtime.createContext({ request, locals: actionContext.locals }));
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const error = payload.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : {};
      throw new Error(typeof error.message === 'string' ? error.message : 'Checkout failed');
    }
    return payload;
  },
});

export const server = { checkout };
