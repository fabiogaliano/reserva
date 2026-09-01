// A non-Brevo transport built entirely from the public `@reservajs/astro/email` seam: the packed
// tarball must let a consumer reuse the shipped template without reaching into any private path.
import { renderDefaultEmail, type EmailRenderer, type EmailTemplateContext, type RenderedEmail } from '@reservajs/astro/email';
import type { ReservaProviders } from '@reservajs/astro/runtime';

const renderer: EmailRenderer = (context) => (
  context.event === 'booking.no_show'
    ? { subject: 'We missed you', html: '<p>house copy for one event</p>' }
    : renderDefaultEmail(context)
);

export const consoleEmailProvider: NonNullable<ReservaProviders['email']> = {
  async send(event, booking, config) {
    const context: EmailTemplateContext = {
      event,
      booking,
      config,
      locale: booking.locale,
      recipient: 'customer',
      customerManageUrl: `${config.business.url}/booking/manage?token=${encodeURIComponent(booking.cancelToken)}`,
      operatorManageUrl: `${config.business.url}/booking/manage?token=${encodeURIComponent(booking.operatorToken)}`,
      startsAtLocal: booking.startsAt,
    };
    const message: RenderedEmail = renderer(context);
    console.log(`[email] ${message.subject}`);
  },
};
