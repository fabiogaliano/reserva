import { adminLocaleFor, resolveLocalizedText, resolveService, resolveServiceTitle } from '../../core/config.js';
import { checkPartnerOfferForService, hasOfferBenefits } from '../../core/partner-offers.js';
import type { ReservaContext } from '../../context.js';
import { escapeHtml } from '../../http.js';
import type { PartnerBookingCount, PartnerRecord } from '../../partners.js';
import { cssAssetHref, jsAssetHref } from '../asset-hrefs.js';
import { pageShell, themeToggle } from '../layout.js';
import { formatMessage, resolveMessages } from '../messages.js';
import { adminErrorAlert, adminTopbar, type AdminErrorNotice } from './admin-page.js';

/** Authenticated registry UI uses native forms and the same chrome/CSRF conventions as settings. */
export function partnersPage(context: ReservaContext, input: {
  readonly partners: readonly PartnerRecord[];
  readonly counts: readonly PartnerBookingCount[];
  readonly editId: string;
  readonly saved: boolean;
  readonly csrfToken: string | undefined;
  readonly error: AdminErrorNotice | null;
  readonly openIncidentCount: number;
}): string {
  const locale = adminLocaleFor(context.config);
  const m = resolveMessages(context.config, locale);
  const e = escapeHtml;
  const pickupLabels = new Map<string, string>();
  for (const service of Object.values(context.config.services)) {
    for (const pickup of service.location?.pickupOptions ?? []) pickupLabels.set(pickup.id, resolveLocalizedText(pickup.label ?? m['pickup.meetingPoint'], locale, context.config.locales.default));
  }
  const edit = input.partners.find((partner) => partner.id === input.editId);
  const referralUrl = (partner: PartnerRecord): string => {
    const url = new URL(context.config.business.url);
    url.searchParams.set('ref', partner.code);
    return url.toString();
  };
  const offerSummary = (partner: PartnerRecord): string => partner.offer
    ? `${partner.offer.enabled ? m['partner.enabled'] : m['partner.disabled']}: ${formatMessage(m['partner.summary'], {
      percentage: String(partner.offer.basisPoints / 100),
      pickups: partner.offer.waivedPickupIds.map((id) => pickupLabels.get(id) ?? id).join(', ') || m['partner.noPickups'],
    })}` : m['partner.none'];
  // Checkout prices these services normally; saying so here is the only place the operator sees it.
  const minimumChargeMinor = context.partnerOffers?.minimumChargeMinorByCurrency[context.config.business.currency] ?? null;
  const outOfScope = (partner: PartnerRecord): string => {
    const offer = partner.offer;
    if (!offer || !hasOfferBenefits(offer)) return '';
    const services = Object.keys(context.config.services)
      .filter((slug) => !checkPartnerOfferForService(offer, resolveService(context.config, slug), minimumChargeMinor).ok)
      .map((slug) => resolveServiceTitle(context.config, slug, locale));
    return services.length ? `<span class="bk-sub">${e(formatMessage(m['partner.outOfScope'], { services: services.join(', ') }))}</span>` : '';
  };
  const rows = input.partners.map((partner) => {
    const count = input.counts.find((row) => row.partnerId === partner.id);
    const url = referralUrl(partner);
    return `<tr><th scope="row"><a href="?view=partners&amp;partner=${e(encodeURIComponent(partner.id))}">${e(partner.name)}</a><span class="bk-sub">${e(partner.code)}</span></th>`
      + `<td>${e(partner.state === 'active' ? m['partner.active'] : m['partner.archived'])}</td><td>${e(offerSummary(partner))}${outOfScope(partner)}</td>`
      + `<td>${count?.upcoming ?? 0}</td><td>${count?.past ?? 0}</td><td><a href="${e(url)}">${e(m['partner.link'])}</a> `
      + `<button type="button" class="bk-btn bk-btn--secondary" aria-label="${e(m['partner.copy'])}" data-reserva-copy="${e(url)}" data-copied="${e(m['partner.copied'])}" hidden>${e(m['partner.copy'])}</button></td></tr>`;
  }).join('');
  const labels: Record<string, string> = { name: m['partner.name'], code: m['partner.code'], state: m['partner.state'], percentage: m['partner.percentage'] };
  const specialError = input.error?.code === 'partner_conflict' ? m['partner.conflict']
    : input.error?.field === 'offer.pricing' ? m['partner.pricingError']
    : input.error?.field === 'offer.pickup' ? m['partner.pickupError']
    : input.error?.field === 'offer.payment_floor' ? m['partner.floorError'] : null;
  const error = specialError ? `<p class="bk-alert bk-alert--danger" role="alert">${e(specialError)}</p>` : adminErrorAlert(m, input.error, (field) => labels[field]);
  const errorAlert = error ? `<div id="partner-error">${error}</div>` : '';
  const invalid = (field: string): string => input.error?.field === field ? ' aria-invalid="true" aria-describedby="partner-error" autofocus' : '';
  const waivers = [...pickupLabels].map(([id, label]) => `<label><input type="checkbox" name="waived_pickup" value="${e(id)}"${edit?.offer?.waivedPickupIds.includes(id) ? ' checked' : ''}> ${e(label)}</label>`).join(' ');
  const form = `<form method="post" class="bk-settings-form">`
    + (input.csrfToken ? `<input type="hidden" name="csrf_token" value="${e(input.csrfToken)}">` : '')
    + (edit ? `<input type="hidden" name="partner_id" value="${e(edit.id)}"><input type="hidden" name="revision" value="${edit.revision}">` : '')
    + `<h2>${e(edit ? m['partner.edit'] : m['partner.create'])}</h2>`
    + `<label class="bk-field">${e(m['partner.name'])}<input class="bk-input" type="text" name="name" value="${e(edit?.name ?? '')}" maxlength="200" required${invalid('name')}></label>`
    + `<label class="bk-field">${e(m['partner.code'])}<input class="bk-input" type="text" name="code" value="${e(edit?.code ?? '')}" maxlength="64" pattern="[a-z0-9][a-z0-9_-]{0,63}" required spellcheck="false" autocapitalize="none" aria-describedby="partner-code-hint${input.error?.field === 'code' ? ' partner-error' : ''}"${edit ? ' readonly' : ''}${input.error?.field === 'code' ? ' aria-invalid="true" autofocus' : ''}></label>`
    + `<p class="bk-hint" id="partner-code-hint">${e(m['partner.codeHint'])}</p>`
    + `<label class="bk-field">${e(m['partner.state'])}<select class="bk-select" name="state"${invalid('state')}><option value="active"${edit?.state !== 'archived' ? ' selected' : ''}>${e(m['partner.active'])}</option><option value="archived"${edit?.state === 'archived' ? ' selected' : ''}>${e(m['partner.archived'])}</option></select></label>`
    + `<label class="bk-field">${e(m['partner.percentage'])}<input class="bk-input" type="number" name="percentage" inputmode="decimal" min="0" max="100" step="0.01" value="${(edit?.offer?.basisPoints ?? 0) / 100}" required aria-describedby="partner-offer-scope${input.error?.field === 'percentage' ? ' partner-error' : ''}"${input.error?.field === 'percentage' ? ' aria-invalid="true" autofocus' : ''}></label>`
    + `<p class="bk-hint" id="partner-offer-scope">${e(m['partner.scope'])}</p>`
    + `<fieldset class="bk-fieldset"><legend>${e(m['partner.pickups'])}</legend>${waivers}</fieldset>`
    + `<label class="bk-switch"><input type="checkbox" name="offer_enabled"${edit?.offer?.enabled ? ' checked' : ''}> ${e(m['partner.enabled'])}</label>`
    + `<p><button class="bk-btn" type="submit" name="action" value="${edit ? 'partner-save' : 'partner-create'}">${e(edit ? m['partner.save'] : m['partner.create'])}</button></p>`
    + (edit?.state === 'active' ? `<p id="partner-archive-hint" class="bk-hint">${e(m['partner.archiveHint'])}</p><button class="bk-btn bk-btn--outline-danger" type="submit" name="action" value="partner-archive" aria-describedby="partner-archive-hint" formnovalidate>${e(m['partner.archive'])}</button>` : '')
    + `</form>`;
  return pageShell({
    lang: locale, page: 'partners', title: `${m['admin.partners']} — ${context.config.business.name}`,
    cssHref: cssAssetHref(context.routeConfig.paths.assetsCss, context.config.ui?.branding),
    favicon: context.config.ui?.faviconUrl, headHtml: context.config.ui?.headHtml,
    scriptHref: jsAssetHref(context.routeConfig.paths.assetsJs),
    topbar: adminTopbar(context, m, 'partners', input.openIncidentCount),
    skipLabel: m['common.skipContent'], theme: context.viewerTheme, themeToggle: themeToggle(m, context.viewerTheme),
    body: `<header class="bk-admin-header"><h1>${e(m['admin.partners'])}</h1><a href="?view=partners">${e(m['partner.create'])}</a></header>`
      + (context.partnerOffers?.enabled !== true ? `<p class="bk-alert bk-alert--warn" role="status">${e(m['partner.gateOff'])}</p>` : '')
      + `<p class="bk-hint">${e(m['partner.eligibility'])}</p>`
      + (input.saved ? `<p class="bk-alert bk-alert--ok" role="status">${e(m['admin.saved'])}</p>` : '') + errorAlert
      + `<div class="bk-partner-list" role="region" aria-label="${e(m['admin.partners'])}" tabindex="0"><table class="bk-tagtable"><thead><tr><th scope="col">${e(m['partner.name'])}</th><th scope="col">${e(m['partner.state'])}</th><th scope="col">${e(m['partner.offer'])}</th><th scope="col">${e(m['admin.tagUpcoming'])}</th><th scope="col">${e(m['admin.tagPast'])}</th><th scope="col">${e(m['partner.link'])}</th></tr></thead><tbody>${rows}</tbody></table></div>`
      + form,
  });
}
