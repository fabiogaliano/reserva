import { renderDefaultEmail } from '../../../src/email/render';
import { booking, config } from '../../../tests/fixtures';
const ctx = (event: any, recipient: any) => ({ event, booking: booking(), config, locale: 'en', recipient, customerManageUrl: 'https://x/m?t=1', operatorManageUrl: 'https://x/m?t=2', startsAtLocal: '15 Jun 2026, 09:00', generatedAt: new Date() });
const cpu = () => process.cpuUsage().user / 1000;
let t = cpu(); renderDefaultEmail(ctx('booking.cancelled_by_operator', 'customer')); renderDefaultEmail(ctx('booking.cancelled_by_operator', 'owner'));
console.log(`cancel emails (customer+owner) first ${(cpu() - t).toFixed(1)} ms`);
t = cpu(); for (let i = 0; i < 20; i++) { renderDefaultEmail(ctx('booking.cancelled_by_operator', 'customer')); renderDefaultEmail(ctx('booking.cancelled_by_operator', 'owner')); }
console.log(`warm ${((cpu() - t) / 20).toFixed(2)} ms per pair`);
