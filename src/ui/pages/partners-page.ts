import { adminLocaleFor, resolveService, resolveServiceTitle, type ResolvedClientConfig } from '../../core/config.js';
import { checkPartnerOfferForService, checkPartnerOfferForServices, hasOfferBenefits, parseOfferPercentage, priceWithPartnerOffer, type PartnerOffer } from '../../core/partner-offers.js';
import { isPricingFormula, priceFor, type PricingFormula } from '../../core/pricing.js';
import type { ReservaContext } from '../../context.js';
import { escapeHtml } from '../../http.js';
import type { PartnerBookingCount, PartnerRecord } from '../../partners.js';
import { cssAssetHref, jsAssetHref } from '../asset-hrefs.js';
import { formatPrice } from '../format.js';
import { pageShell, themeToggle } from '../layout.js';
import { formatMessage, resolveMessages } from '../messages.js';
import { formatPercentage, offerTags, partnerHref, partnerPickups, referralUrl, type PartnerPickup } from '../partner-text.js';
import { adminErrorAlert, adminTopbar, type AdminErrorNotice } from './admin-page.js';

/** What the operator typed into a partner form that was refused, so it comes back as typed. */
export interface PartnerDraft {
  readonly name: string;
  readonly code: string;
  readonly percentage: string;
  readonly waivedPickupIds: readonly string[];
  readonly enabled: boolean;
}

interface PartnersPageInput {
  readonly partners: readonly PartnerRecord[];
  readonly counts: readonly PartnerBookingCount[];
  /** A partner's ID for its page, 'new' for the add form, '' for the list. */
  readonly partnerId: string;
  readonly archived: boolean;
  /** '1', 'created', 'archive' or 'restore' after a successful action; '' otherwise. */
  readonly saved: string;
  readonly draft: PartnerDraft | null;
  readonly csrfToken: string | undefined;
  readonly error: AdminErrorNotice | null;
  readonly openIncidentCount: number;
}

const e = escapeHtml;

const icon = (body: string): string =>
  `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const icons = {
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  pause: '<circle cx="12" cy="12" r="10"/><line x1="10" x2="10" y1="15" y2="9"/><line x1="14" x2="14" y1="15" y2="9"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  error: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
};

function offerServices(config: ResolvedClientConfig): Parameters<typeof checkPartnerOfferForServices>[1] {
  return Object.keys(config.services).map((slug) => {
    const service = resolveService(config, slug);
    return { slug, service, pickupIds: (service.location?.pickupOptions ?? []).map((option) => option.id) };
  });
}

/** The draft's offer as the server would save it, or null when it can't be read back. */
function draftOffer(draft: PartnerDraft): PartnerOffer | null {
  const percent = parseOfferPercentage((draft.percentage || '0').replace(',', '.'));
  return percent.ok ? { enabled: draft.enabled, basisPoints: percent.value, waivedPickupIds: draft.waivedPickupIds } : null;
}

/**
 * Why an offer can't be sold, in numbers: the cheapest booking it would leave below the minimum,
 * and the largest discount every tour could take with the same free pickups.
 */
function floorProblem(context: ReservaContext, offer: PartnerOffer, minimumChargeMinor: number, locale: string): { service: string; priceMinor: number; maxBasisPoints: number | null } | null {
  const config = context.config;
  let lowest: { service: string; priceMinor: number } | null = null;
  for (const slug of Object.keys(config.services)) {
    const service = resolveService(config, slug);
    if (!isPricingFormula(service.pricing)) continue;
    const formula = service.pricing;
    for (const units of new Set([1, formula.maxUnits])) {
      for (const pickup of Object.keys(formula.surcharges).length ? Object.keys(formula.surcharges) : [null]) {
        // A floor of 1 prices the offer as given; the real minimum is compared below.
        const priced = priceWithPartnerOffer({ service, quantity: units * formula.seatsPerUnit, pickup, offer: { ...offer, enabled: true }, minimumChargeMinor: 1 });
        const priceMinor = priced.ok ? priced.value.priceMinor : 0;
        if (priceMinor < minimumChargeMinor && (!lowest || priceMinor < lowest.priceMinor)) lowest = { service: resolveServiceTitle(config, slug, locale), priceMinor };
      }
    }
  }
  if (!lowest) return null;
  const services = offerServices(config);
  const fits = (basisPoints: number): boolean => checkPartnerOfferForServices({ ...offer, basisPoints }, services, minimumChargeMinor).ok;
  let maxBasisPoints: number | null = null;
  if (fits(0)) {
    let low = 0;
    let high = offer.basisPoints;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid;
      else high = mid - 1;
    }
    // A whole percentage is what an operator types; offer one whenever it fits.
    maxBasisPoints = low >= 100 ? low - (low % 100) : low;
  }
  return { ...lowest, maxBasisPoints };
}

/** Authenticated registry UI uses native forms and the same chrome/CSRF conventions as settings. */
export function partnersPage(context: ReservaContext, input: PartnersPageInput): string {
  const config = context.config;
  const locale = adminLocaleFor(config);
  const m = resolveMessages(config, locale);
  const adminPath = context.routeConfig.paths.adminPage;
  const currency = config.business.currency;
  const money = (minor: number): string => formatPrice(minor, locale, currency);
  const pickups = partnerPickups(config, locale, m);
  const minimumChargeMinor = context.partnerOffers?.minimumChargeMinorByCurrency[currency] ?? null;
  const countsFor = (partner: PartnerRecord): PartnerBookingCount =>
    input.counts.find((row) => row.partnerId === partner.id) ?? { partnerId: partner.id, upcoming: 0, past: 0 };

  const gateNotice = context.partnerOffers?.enabled === true ? ''
    : `<div class="bk-alert bk-alert--warn bk-notice" role="status">${icon(icons.pause)}<div><b>${e(m['partner.gateOffTitle'])}</b><span>${e(m['partner.gateOff'])}</span></div></div>`;

  // Checkout prices these services normally; saying so here is the only place the operator sees it.
  const outOfScope = (offer: PartnerOffer | null): string => {
    if (!offer || !offer.enabled || !hasOfferBenefits(offer)) return '';
    const services = Object.keys(config.services)
      .filter((slug) => !checkPartnerOfferForService(offer, resolveService(config, slug), minimumChargeMinor).ok)
      .map((slug) => resolveServiceTitle(config, slug, locale));
    return services.length
      ? `<p class="bk-partner-warn">${icon(icons.alert)}<span>${e(formatMessage(m['partner.outOfScope'], { services: services.join(', ') }))}</span></p>`
      : '';
  };

  const offerMarkup = (partner: PartnerRecord): string => {
    const offer = partner.offer;
    if (!offer || !hasOfferBenefits(offer)) return `<span class="bk-partner-muted">${e(m['partner.noOffer'])}</span><span class="bk-sub">${e(m['partner.noOfferHint'])}</span>`;
    const tags = offerTags(offer, pickups, locale, m).map((tag) => `<span class="bk-partner-tag${offer.enabled ? '' : ' bk-partner-tag--muted'}">${e(tag)}</span>`).join('');
    const paused = offer.enabled ? '' : `<span class="bk-badge">${e(m['partner.paused'])}</span>`;
    return `<div class="bk-partner-tags">${paused}${tags}</div>${outOfScope(offer)}`;
  };

  const copyButton = (partner: PartnerRecord, label: string, iconBody: string): string =>
    `<button type="button" class="bk-btn bk-btn--secondary bk-btn--sm" data-reserva-copy="${e(referralUrl(config, partner.code))}" data-copied="${e(m['partner.copied'])}" aria-label="${e(`${m['partner.copyLink']}: ${partner.name}`)}" hidden>${icon(iconBody)} ${e(label)}</button>`;

  const shell = (title: string, body: string): string => pageShell({
    lang: locale, page: 'partners', title: `${title} — ${config.business.name}`,
    cssHref: cssAssetHref(context.routeConfig.paths.assetsCss, config.ui?.branding),
    favicon: config.ui?.faviconUrl, headHtml: config.ui?.headHtml,
    scriptHref: jsAssetHref(context.routeConfig.paths.assetsJs),
    topbar: adminTopbar(context, m, 'partners', input.openIncidentCount),
    skipLabel: m['common.skipContent'], theme: context.viewerTheme, themeToggle: themeToggle(m, context.viewerTheme),
    body: `<div class="bk-partners">${body}</div>`,
  });
  const csrf = input.csrfToken ? `<input type="hidden" name="csrf_token" value="${e(input.csrfToken)}">` : '';
  const back = `<a class="bk-partner-back" href="${e(`${adminPath}?view=partners`)}">${icon(icons.back)} ${e(m['admin.partners'])}</a>`;

  if (input.partnerId === 'new') return shell(m['partner.add'], back + `<header class="bk-partner-head"><h1>${e(m['partner.add'])}</h1></header>` + partnerForm(null));
  const partner = input.partners.find((candidate) => candidate.id === input.partnerId);
  if (partner) return shell(partner.name, partnerPage(partner));
  return shell(m['admin.partners'], listPage());

  function listPage(): string {
    const archivedCount = input.partners.filter((candidate) => candidate.state === 'archived').length;
    const shown = input.partners.filter((candidate) => (candidate.state === 'archived') === input.archived);
    const listHref = `${adminPath}?view=partners`;
    const filter = archivedCount > 0
      ? `<nav class="bk-chips bk-partner-filter" aria-label="${e(m['admin.partners'])}">`
        + `<a class="bk-chip" href="${e(listHref)}"${input.archived ? '' : ' aria-current="true"'}>${e(m['partner.filterActive'])} <b>${input.partners.length - archivedCount}</b></a>`
        + `<a class="bk-chip" href="${e(`${listHref}&archived=1`)}"${input.archived ? ' aria-current="true"' : ''}>${e(m['partner.filterArchived'])} <b>${archivedCount}</b></a></nav>`
      : '';
    const bookings = (partner: PartnerRecord): string => {
      const count = countsFor(partner);
      if (count.upcoming === 0 && count.past === 0) return `<span class="bk-partner-muted">${e(m['partner.noBookings'])}</span>`;
      return `${e(formatMessage(m['partner.upcoming'], { n: count.upcoming }))}<span class="bk-sub">${e(formatMessage(m['partner.past'], { n: count.past }))}</span>`;
    };
    const nameCell = (partner: PartnerRecord): string =>
      `<a class="bk-partner-name" href="${e(partnerHref(adminPath, partner.id))}">${e(partner.name)}${icon(icons.pencil)}</a><span class="bk-partner-code">${e(partner.code)}</span>`;
    const rows = shown.map((partner) => `<tr><th scope="row">${nameCell(partner)}</th><td>${offerMarkup(partner)}</td>`
      + `<td class="bk-partner-count">${bookings(partner)}</td><td class="bk-partner-action">${copyButton(partner, m['partner.copyLink'], icons.link)}</td></tr>`).join('');
    // The same partners twice: a table where there is room to compare them, cards on a phone.
    // CSS shows exactly one.
    const table = `<table class="bk-partner-table"><thead><tr><th scope="col">${e(m['admin.partner'])}</th><th scope="col">${e(m['partner.offer'])}</th>`
      + `<th scope="col">${e(m['partner.bookings'])}</th><th scope="col"><span class="bk-sr-only">${e(m['partner.link'])}</span></th></tr></thead><tbody>${rows}</tbody></table>`;
    const cards = `<ul class="bk-partner-cards" role="list">${shown.map((partner) => {
      const count = countsFor(partner);
      return `<li class="bk-card bk-partner-card"><h2>${nameCell(partner)}</h2><div>${offerMarkup(partner)}</div>`
        + `<p class="bk-partner-stats"><span>${e(formatMessage(m['partner.upcoming'], { n: count.upcoming }))}</span><span>${e(formatMessage(m['partner.past'], { n: count.past }))}</span></p>`
        + `<div class="bk-partner-linkrow"><span class="bk-partner-url">${e(referralUrl(config, partner.code).replace(/^https?:\/\//, ''))}</span>${copyButton(partner, m['partner.copy'], icons.copy)}</div></li>`;
    }).join('')}</ul>`;
    const empty = `<p class="bk-lead">${e(input.archived ? m['partner.emptyArchived'] : m['partner.empty'])}</p>`;
    return `<header class="bk-partner-head"><div><h1>${e(m['admin.partners'])}</h1><p class="bk-lead">${e(m['partner.lead'])}</p></div>`
      + `<a class="bk-btn" href="${e(partnerHref(adminPath, 'new'))}">${icon(icons.plus)} ${e(m['partner.add'])}</a></header>`
      + gateNotice + filter
      + (shown.length ? table + cards : empty);
  }

  function partnerPage(partner: PartnerRecord): string {
    const count = countsFor(partner);
    const savedText = input.saved === 'created' ? m['partner.savedCreated'] : input.saved === 'archive' ? m['partner.savedArchived']
      : input.saved === 'restore' ? m['partner.savedRestored'] : input.saved ? m['partner.saved'] : '';
    const saved = savedText ? `<p class="bk-alert bk-alert--ok" role="status">${e(savedText)}</p>` : '';
    const badge = partner.state === 'active' ? `<span class="bk-badge bk-badge--ok">${e(m['partner.active'])}</span>` : `<span class="bk-badge">${e(m['partner.archived'])}</span>`;
    const archivedNotice = partner.state === 'archived' ? `<p class="bk-alert bk-alert--warn" role="status">${e(m['partner.archivedNotice'])}</p>` : '';
    const archiving = partner.state === 'active';
    const stateForm = `<form method="post" class="bk-partner-danger${archiving ? '' : ' bk-partner-danger--restore'}">${csrf}`
      + `<input type="hidden" name="partner_id" value="${e(partner.id)}"><input type="hidden" name="code" value="${e(partner.code)}"><input type="hidden" name="revision" value="${partner.revision}">`
      + `<div><h2>${e(archiving ? m['partner.archive'] : m['partner.restore'])}</h2><p id="partner-state-hint">${e(archiving ? m['partner.archiveHint'] : m['partner.restoreHint'])}</p></div>`
      + `<button class="bk-btn ${archiving ? 'bk-btn--outline-danger' : 'bk-btn--secondary'}" type="submit" name="action" value="${archiving ? 'partner-archive' : 'partner-restore'}" aria-describedby="partner-state-hint">${e(archiving ? m['partner.archive'] : m['partner.restore'])}</button></form>`;
    return back
      + `<header class="bk-partner-head"><div><div class="bk-partner-title"><h1>${e(partner.name)}</h1>${badge}</div>`
      + `<p class="bk-lead">${e(formatMessage(m['partner.bookingsSummary'], { upcoming: count.upcoming, past: count.past }))}</p></div></header>`
      + saved + archivedNotice + gateNotice + partnerForm(partner) + stateForm;
  }

  function partnerForm(partner: PartnerRecord | null): string {
    const draft = input.draft;
    const offer = draft ? draftOffer(draft) : partner?.offer ?? null;
    const name = draft?.name ?? partner?.name ?? '';
    const code = partner?.code ?? draft?.code ?? '';
    const percentage = draft ? draft.percentage : formatPercentage(partner?.offer?.basisPoints ?? 0, locale).replace(/\s/g, '');
    const waived = draft?.waivedPickupIds ?? partner?.offer?.waivedPickupIds ?? [];
    const enabled = draft ? draft.enabled : partner?.offer?.enabled ?? false;

    const error = input.error;
    const fieldError = (text: string, id: string): string => `<p class="bk-field-error" id="${id}">${e(text)}</p>`;
    let nameError = '';
    let codeError = '';
    let discountError = '';
    let alert = '';
    const fixBelow = `<div class="bk-alert bk-alert--danger bk-notice" role="alert">${icon(icons.error)}<div><b>${e(m['partner.errorTitle'])}</b><span>${e(m['partner.fixBelow'])}</span></div></div>`;
    const alertWith = (text: string): string => `<div class="bk-alert bk-alert--danger bk-notice" role="alert">${icon(icons.error)}<div><b>${e(m['partner.errorTitle'])}</b><span>${e(text)}</span></div></div>`;
    if (error?.code === 'partner_conflict') {
      if (error.field === 'code') {
        codeError = fieldError(m['partner.codeTaken'], 'partner-code-error');
        alert = fixBelow;
      } else alert = alertWith(m['partner.conflict']);
    } else if (error?.code === 'validation_failed' && ['name', 'code', 'percentage', 'offer.payment_floor'].includes(error.field)) {
      alert = fixBelow;
      if (error.field === 'name') nameError = fieldError(m['partner.nameInvalid'], 'partner-name-error');
      else if (error.field === 'code') codeError = fieldError(m['partner.codeInvalid'], 'partner-code-error');
      else if (error.field === 'percentage') discountError = fieldError(m['partner.percentageInvalid'], 'partner-discount-error');
      else {
        const problem = offer && minimumChargeMinor !== null ? floorProblem(context, offer, minimumChargeMinor, locale) : null;
        const text = minimumChargeMinor === null ? m['partner.floorNoMinimum']
          : problem
            ? `${formatMessage(m['partner.floorError'], { service: problem.service, price: money(problem.priceMinor), minimum: money(minimumChargeMinor) })} ${problem.maxBasisPoints === null ? m['partner.floorPickup'] : formatMessage(m['partner.floorMax'], { max: formatPercentage(problem.maxBasisPoints, locale) })}`
            : m['partner.floorPickup'];
        discountError = fieldError(text, 'partner-discount-error');
      }
    } else if (error?.code === 'validation_failed' && error.field === 'offer.pricing') alert = alertWith(m['partner.pricingError']);
    else if (error?.code === 'validation_failed' && error.field === 'offer.pickup') alert = alertWith(m['partner.pickupError']);
    else if (error) alert = adminErrorAlert(m, error, () => undefined);

    const described = (hint: string, errorId: string, hasError: boolean): string =>
      ` aria-describedby="${hint}${hasError ? ` ${errorId}` : ''}"${hasError ? ' aria-invalid="true" autofocus' : ''}`;

    const linkSection = partner
      ? `<section class="bk-sgroup"><div class="bk-sgroup-head"><h3>${e(m['partner.link'])}</h3><p class="bk-hint">${e(m['partner.linkHint'])}</p></div><div class="bk-sgroup-fields">`
        + `<div class="bk-partner-copyfield"><input class="bk-input" type="url" readonly value="${e(referralUrl(config, partner.code))}" aria-label="${e(m['partner.link'])}" aria-describedby="partner-link-note">${copyButton(partner, m['partner.copy'], icons.copy)}</div>`
        + `<p class="bk-hint" id="partner-link-note">${e(m['partner.linkNote'])}</p></div></section>`
      : '';

    // Waiving a pickup that costs nothing gives nothing, so only charged pickups are offered,
    // plus any already waived so saving never drops one silently.
    const waivable = pickups.filter((pickup) => pickup.charged || waived.includes(pickup.id));
    const pickupChoices = waivable.length
      ? `<fieldset class="bk-fieldset bk-partner-pickups"><legend>${e(m['partner.freePickup'])}</legend>${waivable.map((pickup) =>
        `<label class="bk-check"><input type="checkbox" name="waived_pickup" value="${e(pickup.id)}"${waived.includes(pickup.id) ? ' checked' : ''}> ${e(pickup.label)}`
        + (pickup.chargeMinor !== null ? ` <span class="bk-partner-muted">${e(formatMessage(m['partner.normally'], { amount: money(pickup.chargeMinor) }))}</span>` : '')
        + `</label>`).join('')}</fieldset>`
      : '';
    const offerSection = `<section class="bk-sgroup bk-partner-offer"><div class="bk-sgroup-head"><h3>${e(m['partner.offer'])}</h3><p class="bk-hint">${e(partner ? m['partner.offerHint'] : m['partner.offerOptional'])}</p></div><div class="bk-sgroup-fields">`
      + `<label class="bk-switch"><input type="checkbox" name="offer_enabled" data-reserva-offer-switch${enabled ? ' checked' : ''}> ${e(m['partner.offerSwitch'])}</label>`
      + `<p class="bk-hint bk-partner-offer-off">${e(m['partner.offerOffHint'])}</p>`
      + `<div class="bk-partner-offer-fields">`
      + `<div><label class="bk-field-label" for="partner-discount">${e(m['partner.discount'])}</label>`
      + `<span class="bk-affix${discountError ? ' bk-affix--invalid' : ''}"><input class="bk-input" id="partner-discount" type="text" name="percentage" inputmode="decimal" value="${e(percentage)}" required pattern="\\d{1,3}([.,]\\d{1,2})?" data-reserva-offer-percentage${described('partner-discount-hint', 'partner-discount-error', discountError !== '')}><span class="bk-affix-unit">${e(m['partner.discountUnit'])}</span></span>`
      + discountError + `<p class="bk-hint" id="partner-discount-hint">${e(m['partner.discountHint'])}</p></div>`
      + pickupChoices + previewTable(offer ? { ...offer, waivedPickupIds: waived } : null)
      + `</div></div></section>`;

    const codeField = partner
      ? `<div><span class="bk-field-label">${e(m['partner.code'])}</span><p class="bk-partner-code bk-partner-code--large">${e(partner.code)}</p><p class="bk-hint">${e(m['partner.codeFixed'])}</p></div>`
      : `<div><label class="bk-field-label" for="partner-code">${e(m['partner.code'])}</label><input class="bk-input bk-partner-code-input" id="partner-code" type="text" name="code" value="${e(code)}" maxlength="64" pattern="[a-z0-9][a-z0-9_\\-]{0,63}" required spellcheck="false" autocapitalize="none" autocomplete="off" data-reserva-partner-code${described('partner-code-hint', 'partner-code-error', codeError !== '')}>`
        + `<p class="bk-partner-linkpreview" data-reserva-partner-link="${e(referralUrl(config, '').replace(/^https?:\/\//, ''))}" aria-hidden="true">${e(referralUrl(config, code || 'code').replace(/^https?:\/\//, ''))}</p>`
        + codeError + `<p class="bk-hint" id="partner-code-hint">${e(m['partner.codeHint'])}</p></div>`;
    const nameField = `<div><label class="bk-field-label" for="partner-name">${e(m['partner.name'])}</label><input class="bk-input" id="partner-name" type="text" name="name" value="${e(name)}" maxlength="200" required${partner ? '' : ' data-reserva-partner-name'}${described('partner-name-hint', 'partner-name-error', nameError !== '')}>`
      + nameError + `<p class="bk-hint" id="partner-name-hint">${e(m['partner.nameHint'])}</p></div>`;
    const detailsSection = `<section class="bk-sgroup"><div class="bk-sgroup-head"><h3>${e(partner ? m['partner.details'] : m['admin.partner'])}</h3></div><div class="bk-sgroup-fields">${nameField}${codeField}</div></section>`;

    const hidden = partner
      ? `<input type="hidden" name="partner_id" value="${e(partner.id)}"><input type="hidden" name="code" value="${e(partner.code)}"><input type="hidden" name="revision" value="${partner.revision}">`
      : '';
    const actions = partner
      ? `<button class="bk-btn" type="submit" name="action" value="partner-save">${e(m['partner.save'])}</button>`
      : `<a class="bk-btn bk-btn--secondary" href="${e(`${adminPath}?view=partners`)}">${e(m['partner.cancel'])}</a><button class="bk-btn" type="submit" name="action" value="partner-create">${e(m['partner.add'])}</button>`;
    const sections = partner ? linkSection + offerSection + detailsSection : detailsSection + offerSection;
    return alert + `<form method="post" class="bk-partner-form">${csrf}${hidden}${sections}<div class="bk-partner-actions">${actions}</div></form>`;
  }

  // Server-rendered for the saved (or refused) offer; the enhancer recomputes it as the form changes.
  function previewTable(offer: PartnerOffer | null): string {
    const priced = Object.keys(config.services).map((slug) => ({ slug, service: resolveService(config, slug) }))
      .filter((entry): entry is { slug: string; service: typeof entry.service & { pricing: PricingFormula } } => isPricingFormula(entry.service.pricing));
    if (!priced.length) return '';
    const columns: PartnerPickup[] = pickups.length ? pickups : [{ id: '', label: m['common.price'], chargeMinor: null, charged: false }];
    const cell = (service: (typeof priced)[number]['service'], pickup: PartnerPickup): string => {
      const pickupId = pickups.length ? pickup.id : null;
      if (pickupId !== null && !(service.location?.pickupOptions ?? []).some((option) => option.id === pickupId)) return '<td>—</td>';
      const formula = service.pricing;
      const quantity = formula.seatsPerUnit;
      let original: number;
      try {
        original = priceFor(service, quantity, pickupId);
      } catch {
        return '<td>—</td>';
      }
      const result = offer && offer.enabled && hasOfferBenefits(offer)
        ? priceWithPartnerOffer({ service, quantity, pickup: pickupId, offer, minimumChargeMinor: 1 })
        : null;
      const priceMinor = result?.ok ? result.value.priceMinor : original;
      const below = minimumChargeMinor !== null && priceMinor < original && priceMinor < minimumChargeMinor;
      const surcharge = pickupId === null ? 0 : formula.surcharges[pickupId] ?? 0;
      const data = ` data-service="${formula.baseMinor}" data-pickup="${surcharge}" data-pickup-id="${e(pickupId ?? '')}" data-original="${original}"`;
      const shown = priceMinor < original
        ? `<s>${e(money(original))}</s> <b>${e(money(priceMinor))}</b>${below ? ` <span class="bk-partner-below">${e(m['partner.previewBelowMinimum'])}</span>` : ''}`
        : e(money(original));
      return `<td${data}>${shown}</td>`;
    };
    return `<div class="bk-partner-preview"><span class="bk-field-label" id="partner-preview-label">${e(m['partner.preview'])}</span>`
      + `<table aria-labelledby="partner-preview-label" data-reserva-offer-preview data-locale="${e(locale)}" data-currency="${e(currency)}" data-minimum="${minimumChargeMinor ?? ''}" data-below="${e(m['partner.previewBelowMinimum'])}">`
      + `<thead><tr><th scope="col">${e(m['partner.previewService'])}</th>${columns.map((pickup) => `<th scope="col">${e(pickup.label)}</th>`).join('')}</tr></thead>`
      + `<tbody>${priced.map(({ slug, service }) => `<tr><th scope="row">${e(resolveServiceTitle(config, slug, locale))}</th>${columns.map((pickup) => cell(service, pickup)).join('')}</tr>`).join('')}</tbody></table>`
      + `<p class="bk-hint">${e(m['partner.previewHint'])}</p></div>`;
  }
}

