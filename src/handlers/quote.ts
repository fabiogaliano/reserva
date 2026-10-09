import type { QuoteResponse } from '../core/api.js';
import { resolveService } from '../core/config.js';
import type { ReservaContext } from '../context.js';
import { HttpError, json, requestJson, requireInteger, requireString } from '../http.js';
import { resolvePickupAxis } from './checkout.js';
import { assertSupportedPartySize } from './availability.js';
import { quoteReferralSelection } from '../referral-pricing.js';
import { referralHttpError } from './referral.js';
import { run } from './shared.js';

// Checkout uses the same one-read referral and pricing calculation, never browser amounts.
export function handleQuote(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const serviceSlug = requireString(body.serviceSlug, 'serviceSlug');
    if (!context.config.services[serviceSlug]) {
      const declared = Object.keys(context.config.services);
      throw new HttpError(400, 'validation_failed', `serviceSlug must be one of: ${declared.join(', ')}`, { field: 'serviceSlug', allowed: declared });
    }
    const quantity = requireInteger(body.quantity, 'quantity');
    const service = resolveService(context.config, serviceSlug);
    const pickup = resolvePickupAxis(service, body.pickup, 'pickup');
    // A `locale` sent by a payload builder shared with checkout is accepted and dropped without a
    // word: a price never varies by locale, so there is nothing to negotiate and nothing to reject.
    assertSupportedPartySize(service, quantity);
    const selection = await quoteReferralSelection(context, { serviceSlug, service, quantity, pickup, referralCode: body.referralCode });
    if (!selection.ok) throw referralHttpError(selection.error);
    return json<QuoteResponse>(selection.value.quote);
  }).then((response) => {
    response.headers.set('cache-control', 'no-store');
    return response;
  });
}
