// The whole public surface of @reservajs/stripe: one factory. The implementation class stays
// internal so the adapter can change shape without breaking consumers, and so there is exactly one
// documented way to wire Stripe into a Reserva runtime.
import type { PaymentProvider } from '@reservajs/astro/core';
import { StripeProvider, type StripeOptions } from './provider.js';

export type { StripeClient, StripeOptions, StripePaymentMethod } from './provider.js';

export function stripe(options: StripeOptions): PaymentProvider {
  return new StripeProvider(options);
}
