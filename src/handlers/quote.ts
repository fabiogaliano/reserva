import type { QuoteResponse } from '../core/api';
import { resolveService } from '../core/config';
import type { ReservaContext } from '../context';
import { HttpError, json, requestJson, requireInteger, requireString } from '../http';
import { quotedPriceMinor, resolvePickupAxis } from './checkout';
import { run } from './shared';

// Plan 027 (design decision 1): the pricing authority a headless consumer renders from. Before it
// existed, the first consumer's widget reimplemented the whole pricing matrix client-side behind a
// comment warning that "any drift means the customer pays a different price than shown".
//
// It cannot drift by construction: the pickup axis is validated by the same `resolvePickupAxis` and
// the amount comes from the same `quotedPriceMinor` that `handleCheckout` charges through (see
// src/handlers/checkout.ts). This endpoint adds no pricing logic of its own — only the parts of
// checkout that have nothing to do with money (slot availability, capacity, holds, payment session)
// are absent.
export function handleQuote(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const serviceSlug = requireString(body.serviceSlug, 'serviceSlug');
    if (!context.config.services[serviceSlug]) throw new HttpError(400, 'validation_failed', 'Unknown service');
    const quantity = requireInteger(body.quantity, 'quantity');
    const service = resolveService(context.config, serviceSlug);
    const pickup = resolvePickupAxis(service, body.pickup, 'pickup');
    // Accepted so a consumer can quote with the same payload builder it checks out with, and
    // type-checked here — but never negotiated or stored, because a price never varies by locale.
    if (body.locale !== undefined) requireString(body.locale, 'locale');
    return json<QuoteResponse>({
      priceMinor: quotedPriceMinor(service, quantity, pickup),
      // The booking's currency is captured from this same config value at checkout, so a quote and
      // the charge that follows are always denominated identically.
      currency: context.config.business.currency,
    });
  });
}
