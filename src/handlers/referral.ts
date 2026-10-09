import type { ReferralResolution } from '../core/api.js';
import type { ReservaContext } from '../context.js';
import { HttpError, json, requestJson, requireString } from '../http.js';
import { resolveReferral, type ReferralPricingError } from '../referral-pricing.js';
import { run } from './shared.js';

/** Translate typed application failures at the HTTP boundary without leaking registry contents. */
export function referralHttpError(error: ReferralPricingError): HttpError {
  if (error.reason === 'storage') return new HttpError(503, 'partner_storage_unavailable', 'Referral resolution is temporarily unavailable. Retry before checkout.');
  // Offers outside a service's scope are priced normally, so a remaining pricing failure is the
  // selection itself: a party size and pickup the service has no price for.
  return new HttpError(400, 'validation_failed', error.message, { field: error.reason === 'invalid_code' ? 'referralCode' : 'quantity' });
}

/** Resolve only one supplied referral; errors cannot be cached or mistaken for expiration. */
export function handleResolveReferral(request: Request, context: ReservaContext): Promise<Response> {
  return run(async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
    const body = await requestJson(request);
    const resolved = await resolveReferral(context, requireString(body.referralCode, 'referralCode'));
    if (!resolved.ok) throw referralHttpError(resolved.error);
    const projection = resolved.value.public;
    if (projection.status === 'none') throw new Error('A required referral code resolved as absent');
    return json<ReferralResolution>(projection);
  }).then((response) => {
    response.headers.set('cache-control', 'no-store');
    return response;
  });
}
