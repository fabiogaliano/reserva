import { adminLocaleFor, resolveLocalizedText, type ResolvedServiceConfig } from '../../core/config.js';
import { minorUnitDigits, toMajorUnits } from '../../core/currency.js';
import { formatLocaleFor } from '../../core/locale.js';
import {
  settingDefinitionsFor,
  settingSections,
  type PricingFormulaGroup,
  type PricingTierGroup,
  type ScheduleRuleGroup,
  type SettingDefinition,
  type SettingSection,
  type SettingValue,
} from '../../core/settings.js';
import type { ReservaContext } from '../../context.js';
import { escapeHtml } from '../../http.js';
import type { AdminChangeHistoryEntry } from '../../repo.js';
import { cssAssetHref, jsAssetHref } from '../asset-hrefs.js';
import { factList, pageShell, themeToggle } from '../layout.js';
import { formatMessage, resolveMessages } from '../messages.js';
import { adminErrorAlert, adminTopbar, type AdminErrorNotice } from './admin-page.js';
import { dateTimeFormat, numberFormat } from '../../core/intl.js';
import { formatDateTime, formatDayDate } from '../format.js';

// The admin settings page (?view=settings). A two-column form: each group's title on the left,
// its always-editable fields on the right, so the control is the value and there is no reveal
// step. Sections sit behind a side list (a tab bar on narrow screens) that degrades to links.
// csrfToken is undefined when CSRF isn't configured. changeHistory is null unless the Recent
// changes section is the one requested: only then is it loaded, and only then rendered.
export function settingsPage(
  context: ReservaContext,
  storedRows: Record<string, string>,
  saved: boolean,
  sectionParam: string,
  csrfToken: string | undefined,
  error: AdminErrorNotice | null = null,
  openIncidentCount = 0,
  changeHistory: readonly AdminChangeHistoryEntry[] | null = null,
): string {
  const locale = adminLocaleFor(context.config);
  const messages = resolveMessages(context.config, locale);
  const catalog = messages as Record<string, string>;
  // Section links are plain ?section= links so switching works without JS; the enhancer upgrades
  // them to instant in-page toggles. The section param survives save redirects.
  const activeSection = ([...settingSections, 'config', 'history'] as string[]).includes(sectionParam)
    ? sectionParam
    : settingSections[0] ?? 'policy';
  // What the operator's values fall back to: the pristine file config when overrides are active.
  const base = context.baseConfig ?? context.config;
  const definitions = settingDefinitionsFor(base);
  const sectionTitles: Record<SettingSection, string> = {
    policy: messages['admin.sectionPolicy'],
    hours: messages['admin.sectionHours'],
    pricing: messages['admin.sectionPricing'],
    capacity: messages['admin.sectionCapacity'],
    contact: messages['admin.sectionContact'],
    legal: messages['admin.sectionLegal'],
  };
  const sectionHints: Record<SettingSection, string> = {
    policy: messages['admin.sectionPolicyHint'],
    hours: messages['admin.sectionHoursHint'],
    pricing: messages['admin.sectionPricingHint'],
    capacity: messages['admin.sectionCapacityHint'],
    contact: messages['admin.sectionContactHint'],
    legal: messages['admin.sectionLegalHint'],
  };
  // 2024-01-07 is a Sunday, so day index 0..6 (config convention: 0 = Sunday) maps onto it directly.
  const weekdayName = (day: number): string =>
    dateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + day)));
  // Monday-first, the way a week is read here; the config's own indices stay 0 = Sunday.
  const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const dayNames = (days: readonly number[]): string =>
    days.length === 7 ? messages['settingGroup.everyDay'] : [...days].sort((a, b) => a - b).map(weekdayName).join(', ');
  const monthDayName = (monthDay: string): string => {
    const [month = 1, day = 1] = monthDay.split('-').map(Number);
    return dateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, month - 1, day)));
  };
  const ruleFor = ({ serviceSlug, ruleIndex, rule }: ScheduleRuleGroup) =>
    (serviceSlug === undefined ? context.config.hours?.[ruleIndex] : context.config.services[serviceSlug]?.schedule[ruleIndex]) ?? rule;
  // A schedule rule's heading names the service (or every service, for the shared block) and, for
  // a seasonal rule, the window it covers. The days it runs are a statement inside the group, not
  // part of its title.
  const scheduleRuleHeading = (group: ScheduleRuleGroup): string => {
    const rule = ruleFor(group);
    const owner = group.serviceTitle ?? messages['settingGroup.sharedHours'];
    return rule.from || rule.to
      ? formatMessage(messages['settingGroup.scheduleRuleSeason'], { service: owner, from: monthDayName(rule.from ?? '01-01'), to: monthDayName(rule.to ?? '12-31') })
      : owner;
  };
  // A pickup option's own declared label, from whichever service declares it; the id is the last
  // resort for a shared surcharge no current service names.
  const pickupLabel = (pickupId: string, services: readonly ResolvedServiceConfig[]): string => {
    for (const service of services) {
      const option = service.location?.pickupOptions.find((candidate) => candidate.id === pickupId);
      if (!option) continue;
      return option.label ? resolveLocalizedText(option.label, locale, context.config.locales.default) : messages['pickup.meetingPoint'];
    }
    return pickupId;
  };
  const pricingFormulaLabel = (group: PricingFormulaGroup, fallback: string): string =>
    group.field === 'surcharge' && group.pickupId !== undefined
      ? formatMessage(messages['setting.surcharge'], { pickup: pickupLabel(group.pickupId, group.services) })
      : fallback;
  // A tier's own description, since its label can't be a static message key: the quantity band and,
  // where the service has a pickup axis, the pickup option's own declared label (same resolution
  // as the catalog). Only the implied meeting-point option falls back to the message catalog.
  const pricingTierLabel = ({ rule, service }: PricingTierGroup): string => {
    if (rule.pickup === undefined) return formatMessage(messages['setting.priceTierNoPickup'], { n: rule.maxQuantity });
    return formatMessage(messages['setting.priceTier'], { n: rule.maxQuantity, pickup: pickupLabel(rule.pickup, [service]) });
  };
  // Money is stored in minor units but only ever shown to an operator in major ones.
  const majorUnits = (value: number, currency: string): string =>
    toMajorUnits(value, currency).toFixed(minorUnitDigits(currency));
  const displayValue = (definition: SettingDefinition, value: SettingValue): string => {
    if (Array.isArray(value)) return dayNames(value);
    if (value === null) return messages['admin.none'];
    if (typeof value === 'boolean') return value ? messages['admin.on'] : messages['admin.off'];
    if (definition.kind.type === 'money') return majorUnits(value as number, definition.kind.currency);
    return String(value);
  };
  const labelFor = (definition: SettingDefinition): string => {
    const fallback = catalog[definition.labelKey] ?? definition.key;
    if (definition.pricingTier) return pricingTierLabel(definition.pricingTier);
    if (definition.pricingFormula) return pricingFormulaLabel(definition.pricingFormula, fallback);
    return fallback;
  };
  // The currency sits on whichever side the locale writes it ("€ 25" vs "25 €"), so a price input
  // reads the way the same price is printed everywhere else.
  const currencyUnit = (currency: string): { text: string; before: boolean } => {
    const parts = numberFormat(formatLocaleFor(locale), { style: 'currency', currency: currency.toUpperCase() }).formatToParts(1);
    const symbolAt = parts.findIndex((part) => part.type === 'currency');
    return { text: parts[symbolAt]?.value ?? currency.toUpperCase(), before: symbolAt < parts.findIndex((part) => part.type === 'integer') };
  };
  const valueOf = (definition: SettingDefinition): string => {
    const effective = definition.get(context.config);
    if (effective === null) return '';
    return definition.kind.type === 'money' ? majorUnits(effective as number, definition.kind.currency) : String(effective);
  };

  // Every control is rendered open: the input is the value. A field that deviates from the file
  // config carries a Modified badge, its fallback, and a Reset; the enhancer adds a "not saved"
  // badge the moment the operator edits it, so the two states never share a look.
  const badgesFor = (definition: SettingDefinition): string =>
    (storedRows[definition.key] !== undefined ? `<span class="bk-badge bk-badge--accent">${escapeHtml(messages['admin.modified'])}</span>` : '')
    + `<span class="bk-badge bk-badge--warn bk-sfield-dirty" hidden>${escapeHtml(messages['admin.unsaved'])}</span>`;
  // `cell` renders the bare control for a pricing-table cell, where the row and column headers
  // already say what the value is; the label is kept for screen readers only.
  const controlMarkup = (definition: SettingDefinition, cell = false): string => {
    const label = labelFor(definition);
    const effective = definition.get(context.config);
    const kind = definition.kind;
    const heading = cell
      ? `<span class="bk-sr-only">${escapeHtml(label)}</span>`
      : `<span class="bk-sfield-label">${escapeHtml(label)}${badgesFor(definition)}</span>`;
    if (kind.type === 'boolean') {
      return `<label class="bk-switch"><input type="checkbox" name="${escapeHtml(definition.key)}"${effective ? ' checked' : ''}>${heading}</label>`;
    }
    if (kind.type === 'days') {
      const selected = Array.isArray(effective) ? effective : [];
      const boxes = WEEKDAY_ORDER.map((day) =>
        `<label class="bk-check"><input type="checkbox" name="${escapeHtml(definition.key)}" value="${day}"${selected.includes(day) ? ' checked' : ''}><span>${escapeHtml(weekdayName(day))}</span></label>`).join('');
      return `<fieldset class="bk-fieldset"><legend>${heading}</legend><div class="bk-days">${boxes}</div></fieldset>`;
    }
    const inputType = kind.type === 'int' || kind.type === 'number' || kind.type === 'money' ? 'number' : kind.type === 'email' ? 'email' : kind.type === 'url' ? 'url' : kind.type === 'time' ? 'time' : 'text';
    const moneyStep = kind.type === 'money' ? (minorUnitDigits(kind.currency) === 0 ? '1' : `0.${'0'.repeat(minorUnitDigits(kind.currency) - 1)}1`) : '';
    const constraints = kind.type === 'int' ? ` min="${kind.min}"${kind.max !== undefined ? ` max="${kind.max}"` : ''} step="1"${kind.optional ? '' : ' required'}`
      : kind.type === 'number' ? ` min="${kind.min}" step="any" required`
      : kind.type === 'money' ? ` min="0" step="${moneyStep}" required`
      : (kind.type === 'text' || kind.type === 'url') && kind.optional ? '' : ' required';
    const wide = inputType === 'text' || inputType === 'email' || inputType === 'url';
    const input = `<input class="bk-input${wide ? ' bk-input--wide' : ''}" type="${inputType}" name="${escapeHtml(definition.key)}" value="${escapeHtml(valueOf(definition))}"${constraints}>`;
    // The unit lives in the box beside the number, so the label no longer has to carry it.
    const unit = kind.type === 'money'
      ? currencyUnit(kind.currency)
      : catalog[`${definition.labelKey}.unit`] ? { text: catalog[`${definition.labelKey}.unit`] as string, before: false } : null;
    const unitMarkup = unit ? `<span class="bk-affix-unit">${escapeHtml(unit.text)}</span>` : '';
    const control = unit ? `<span class="bk-affix">${unit.before ? unitMarkup : ''}${input}${unit.before ? '' : unitMarkup}</span>` : input;
    return cell
      ? `<label class="bk-field">${heading}${control}</label>${badgesFor(definition)}`
      : `<label class="bk-field">${heading}${control}</label>`;
  };

  // The reset button sits outside any <label> so clicking it never toggles the control it belongs to.
  const resetMarkup = (definition: SettingDefinition): string => {
    if (storedRows[definition.key] === undefined) return '';
    return `<span class="bk-modified">`
      + `<span>${escapeHtml(formatMessage(messages['admin.default'], { v: displayValue(definition, definition.get(base)) }))}</span>`
      + `<button type="submit" class="bk-linkbtn" name="action" value="settings-reset:${escapeHtml(definition.key)}" formnovalidate>${escapeHtml(messages['admin.resetField'])}</button>`
      + `</span>`;
  };

  // A hint with a {v} restates the setting as the sentence a customer would live by ("can cancel
  // until 24 hours before"), with the number kept live by the enhancer while it is edited.
  const hintMarkup = (definition: SettingDefinition): string => {
    const hint = catalog[`${definition.labelKey}.hint`];
    if (!hint) return '';
    const [before, ...rest] = hint.split('{v}');
    if (rest.length === 0) return `<span class="bk-hint">${escapeHtml(hint)}</span>`;
    const value = valueOf(definition) || '0';
    return `<span class="bk-hint">${escapeHtml(before ?? '')}`
      + rest.map((after) => `<b data-reserva-live>${escapeHtml(value)}</b>${escapeHtml(after)}`).join('')
      + `</span>`;
  };

  const fieldMarkup = (definition: SettingDefinition, extraHint = ''): string =>
    `<div class="bk-sfield">${controlMarkup(definition)}${resetMarkup(definition)}${hintMarkup(definition)}${extraHint}</div>`;

  // One group: its title (and, for a service's own closing-time rule, the departure it derives) on
  // the left, the fields on the right. The title column is the only structure the page has; there
  // are no rules between fields.
  const groupMarkup = (title: string, fields: string, aside = '', wide = false): string =>
    `<div class="bk-sgroup"><div class="bk-sgroup-head"><h3>${escapeHtml(title)}</h3>${aside}</div><div class="bk-sgroup-fields${wide ? ' bk-sgroup-fields--wide' : ''}">${fields}</div></div>`;

  // The four opening-hours fields of one rule form a single group. A service's own closing-time
  // rule also shows the departure it derives; the shared block cannot, since every service derives
  // its own from its duration.
  const scheduleGroup = (title: string, group: SettingDefinition[]): string => {
    const closing = group.find((definition) => definition.key.endsWith('.lastEnd'));
    const scheduleRule = closing?.scheduleRule;
    const derived = closing && scheduleRule?.serviceSlug !== undefined
      ? `<p class="bk-hint">${escapeHtml(formatMessage(messages['setting.lastDeparture'], { time: (ruleFor(scheduleRule) as { lastStart?: string }).lastStart ?? '' }))}</p>`
      : '';
    return groupMarkup(title, group.map((definition) => fieldMarkup(definition)).join(''), derived);
  };

  // A service's price tiers as one table: a row per pickup option, a column per party size. Laid
  // out as a list, every price repeated "Up to 4 · <pickup>" and the page grew a screen per service.
  const pricingTable = (run: SettingDefinition[]): string => {
    const tierOf = (definition: SettingDefinition): PricingTierGroup => definition.pricingTier as PricingTierGroup;
    const cell = (definition: SettingDefinition): string =>
      `<div class="bk-sfield bk-sfield--cell">${controlMarkup(definition, true)}${resetMarkup(definition)}</div>`;
    const people = (n: number): string => escapeHtml(formatMessage(messages['admin.pricePeople'], { n }));
    const first = run[0];
    if (!first) return '';
    if (tierOf(first).rule.pickup === undefined) {
      const rows = run.map((definition) => `<tr><th scope="row">${people(tierOf(definition).rule.maxQuantity)}</th><td>${cell(definition)}</td></tr>`).join('');
      return `<table class="bk-pricegrid"><thead><tr><th scope="col">${escapeHtml(messages['admin.pricePartySize'])}</th><th scope="col">${escapeHtml(messages['admin.price'])}</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    const quantities = [...new Set(run.map((definition) => tierOf(definition).rule.maxQuantity))].sort((a, b) => a - b);
    const pickups = [...new Set(run.map((definition) => tierOf(definition).rule.pickup ?? ''))];
    const service = tierOf(first).service;
    const head = `<tr><th scope="col">${escapeHtml(messages['common.pickup'])}</th>${quantities.map((n) => `<th scope="col">${people(n)}</th>`).join('')}</tr>`;
    const rows = pickups.map((pickup) => `<tr><th scope="row">${escapeHtml(pickupLabel(pickup, [service]))}</th>`
      + quantities.map((n) => {
        const definition = run.find((candidate) => tierOf(candidate).rule.pickup === pickup && tierOf(candidate).rule.maxQuantity === n);
        return `<td>${definition ? cell(definition) : '—'}</td>`;
      }).join('')
      + `</tr>`).join('');
    return `<table class="bk-pricegrid"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  };

  // One section body: consecutive definitions with the same groupKey share a group.
  const sectionBody = (sectionDefinitions: SettingDefinition[]): string => {
    let body = '';
    for (let index = 0; index < sectionDefinitions.length;) {
      const definition = sectionDefinitions[index] as SettingDefinition;
      const groupTitle = definition.scheduleRule ? scheduleRuleHeading(definition.scheduleRule)
        : definition.pricingTier ? definition.pricingTier.serviceTitle
        : definition.pricingFormula ? definition.pricingFormula.serviceTitle ?? catalog[`settingGroup.${definition.groupKey?.split('.')[1] ?? ''}`]
        : catalog[definition.groupKey ?? ''] ?? definition.groupKey;
      let next = index + 1;
      while (definition.groupKey !== undefined && next < sectionDefinitions.length && sectionDefinitions[next]?.groupKey === definition.groupKey) next += 1;
      const run = sectionDefinitions.slice(index, next);
      body += definition.scheduleRule
        ? scheduleGroup(groupTitle ?? '', run)
        : run.every((member) => member.pricingTier)
          ? groupMarkup(groupTitle ?? '', pricingTable(run), '', true)
          : groupMarkup(groupTitle ?? '', run.map((member) => fieldMarkup(member)).join(''));
      index += run.length;
    }
    return body;
  };

  const sections = settingSections.map((section) => {
    const sectionDefinitions = definitions.filter((definition) => definition.section === section);
    const overrides = sectionDefinitions.filter((definition) => definition.override);
    let body = sectionBody(sectionDefinitions.filter((definition) => !definition.override));
    if (overrides.length > 0) {
      // Open when the operator has already touched one, so a Modified badge is never hidden.
      const touched = overrides.some((definition) => storedRows[definition.key] !== undefined);
      const groups = new Set(overrides.map((definition) => definition.groupKey)).size;
      body += `<details class="bk-overrides"${touched ? ' open' : ''}><summary>${escapeHtml(formatMessage(messages['settingGroup.overrides'], { n: groups }))}</summary>`
        + `<p class="bk-hint">${escapeHtml(messages['settingGroup.overridesHint'])}</p>`
        + sectionBody(overrides)
        + `</details>`;
    }
    const hasOverrides = sectionDefinitions.some((definition) => storedRows[definition.key] !== undefined);
    // formnovalidate on resets: emptied required fields must not block returning to config values.
    const sectionReset = hasOverrides
      ? `<button type="submit" class="bk-linkbtn" name="action" value="settings-reset" formnovalidate>${escapeHtml(messages['admin.resetSection'])}</button>`
      : '';
    // Enter in a field submits through the form's first submit button, which would otherwise be a
    // field's Reset. This invisible Save comes first in tree order so implicit submission always
    // saves; it is kept out of the tab order and the accessibility tree, where the visible Save is.
    const defaultSave = `<button type="submit" class="bk-sr-only" name="action" value="settings-save" tabindex="-1" aria-hidden="true">${escapeHtml(messages['admin.save'])}</button>`;
    // Save is the step operators miss, so the bar pins to the bottom of the viewport. The enhancer
    // keeps it quiet until something changes, then counts the edits and offers Discard; the
    // messages ride on data-* so it needs no i18n island.
    const savebar = `<div class="bk-actions bk-actions--split bk-savebar"`
      + ` data-l-clean="${escapeHtml(messages['admin.noUnsaved'])}" data-l-one="${escapeHtml(messages['admin.unsavedCountOne'])}" data-l-many="${escapeHtml(messages['admin.unsavedCount'])}">`
      + `<span class="bk-savebar-status"><button type="submit" class="bk-btn" name="action" value="settings-save">${escapeHtml(messages['admin.save'])}</button>`
      + `<button type="reset" class="bk-btn bk-btn--secondary" data-reserva-discard hidden>${escapeHtml(messages['admin.discard'])}</button>`
      + `<span class="bk-savebar-msg" role="status" data-reserva-savebar-msg></span></span>${sectionReset}</div>`;
    return `<form method="post" class="bk-settings-form" id="bk-s-${section}"${section === activeSection ? '' : ' hidden'}>${defaultSave}<h2>${escapeHtml(sectionTitles[section])}</h2>`
      + `<p class="bk-hint">${escapeHtml(sectionHints[section])}</p>`
      + `<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><input type="hidden" name="section" value="${escapeHtml(section)}">${body}`
      + `${savebar}</form>`;
  }).join('');

  // Deploy-time values on their own tab: reference material, not daily controls.
  const readonlySection = `<section class="bk-settings-form" id="bk-s-config"${activeSection === 'config' ? '' : ' hidden'}><h2>${escapeHtml(messages['admin.sectionReadonly'])}</h2>`
    + `<p class="bk-hint">${escapeHtml(messages['admin.readonlyHint'])}</p>`
    + factList([
      [messages['setting.timezone'], escapeHtml(context.config.business.timezone)],
      [messages['setting.currency'], escapeHtml(context.config.business.currency.toUpperCase())],
      [messages['setting.locales'], escapeHtml(context.config.locales.supported.join(', '))],
      [messages['setting.shortCode'], escapeHtml(context.config.business.shortCode)],
      [messages['setting.siteUrl'], escapeHtml(context.config.business.url)],
      [messages['setting.services'], escapeHtml(Object.keys(context.config.services).join(', '))],
    ])
    + `</section>`;

  // A recorded setting key the current config no longer declares keeps its raw key and value.
  const historyItemLabel = (definition: SettingDefinition): string => {
    const label = labelFor(definition);
    const group = definition.scheduleRule ? scheduleRuleHeading(definition.scheduleRule)
      : definition.pricingTier?.serviceTitle ?? definition.pricingFormula?.serviceTitle;
    return group ? `${group} · ${label}` : label;
  };
  const historyValue = (definition: SettingDefinition | undefined, raw: string): string => {
    if (!definition) return raw;
    try {
      return displayValue(definition, JSON.parse(raw) as SettingValue);
    } catch {
      return raw;
    }
  };
  const capacityOf = (raw: string | null): { capacity: number; reason: string | null } | null => {
    try {
      const parsed = JSON.parse(raw ?? '') as { capacity?: unknown; reason?: unknown };
      return typeof parsed.capacity === 'number' ? { capacity: parsed.capacity, reason: typeof parsed.reason === 'string' && parsed.reason ? parsed.reason : null } : null;
    } catch {
      return null;
    }
  };
  const partnerHistoryValue = (raw: string | null): { event: string; name: string; code: string } | null => {
    try {
      const parsed = JSON.parse(raw ?? '') as { event?: unknown; name?: unknown; code?: unknown };
      return typeof parsed.event === 'string' && typeof parsed.name === 'string' && typeof parsed.code === 'string'
        ? { event: parsed.event, name: parsed.name, code: parsed.code } : null;
    } catch {
      return null;
    }
  };
  const historyChange = (entry: AdminChangeHistoryEntry): string => {
    if (entry.domain === 'partner') {
      const value = partnerHistoryValue(entry.value);
      if (!value) return escapeHtml(formatMessage(messages['admin.historyPartnerChanged'], { id: entry.itemKey }));
      return escapeHtml(formatMessage(messages[value.event === 'created' ? 'admin.historyPartnerCreated' : 'admin.historyPartnerUpdated'], { name: value.name, code: value.code }));
    }
    if (entry.domain === 'setting') {
      const definition = definitions.find((candidate) => candidate.key === entry.itemKey);
      const item = definition ? historyItemLabel(definition) : entry.itemKey;
      return escapeHtml(entry.action === 'delete' || entry.value === null
        ? formatMessage(messages['admin.historySettingReset'], { item })
        : formatMessage(messages['admin.historySettingSet'], { item, v: historyValue(definition, entry.value) }));
    }
    const date = formatDayDate(entry.itemKey, locale, context.clock());
    const set = entry.action === 'upsert' ? capacityOf(entry.value) : null;
    const reason = set?.reason ? `<span class="bk-sub">${escapeHtml(set.reason)}</span>` : '';
    if (entry.domain === 'day_override') {
      if (!set) return escapeHtml(formatMessage(messages['admin.historyDayCleared'], { date }));
      return escapeHtml(set.capacity === 0
        ? formatMessage(messages['admin.historyDayClosed'], { date })
        : formatMessage(messages['admin.historyDaySet'], { date, n: set.capacity })) + reason;
    }
    if (!set) return escapeHtml(formatMessage(messages['admin.historyDefaultRemoved'], { date }));
    return escapeHtml(formatMessage(messages['admin.historyDefaultSet'], { date, n: set.capacity })) + reason;
  };
  const historyRows = (changeHistory ?? []).map((entry) =>
    `<tr data-change-domain="${escapeHtml(entry.domain)}" data-change-key="${escapeHtml(entry.itemKey)}">`
    + `<td><time datetime="${escapeHtml(entry.changedAt)}">${escapeHtml(formatDateTime(entry.changedAt, locale, context.config.business.timezone))}</time></td>`
    + `<td>${escapeHtml(entry.actor ?? messages['admin.historyUnknownActor'])}</td>`
    + `<td>${historyChange(entry)}</td></tr>`).join('');
  const historySection = activeSection === 'history'
    ? `<section class="bk-settings-form" id="bk-s-history"><h2>${escapeHtml(messages['admin.sectionHistory'])}</h2>`
      + `<p class="bk-hint">${escapeHtml(messages['admin.historyHint'])}</p>`
      + (historyRows
        ? `<table class="bk-history"><thead><tr><th scope="col">${escapeHtml(messages['admin.historyWhen'])}</th><th scope="col">${escapeHtml(messages['admin.historyWho'])}</th><th scope="col">${escapeHtml(messages['admin.historyWhat'])}</th></tr></thead><tbody>${historyRows}</tbody></table>`
        : `<p class="bk-lead">${escapeHtml(messages['admin.historyEmpty'])}</p>`)
      + `</section>`
    : '';

  // The same section links twice: a side list on wide screens, where it can also count what each
  // section has modified, and a scrolling tab bar on narrow ones. CSS shows exactly one.
  const modifiedIn = (section: string): number =>
    definitions.filter((definition) => definition.section === section && storedRows[definition.key] !== undefined).length;
  // Recent changes is loaded only when requested, so its link navigates instead of toggling a
  // panel the page does not have.
  const sectionLink = (id: string, label: string, count = 0): string =>
    `<a href="?view=settings&section=${id}"${id === 'history' ? '' : ` data-reserva-tab="${id}"`}${id === activeSection ? ' aria-current="page"' : ''}>${escapeHtml(label)}`
    + (count > 0 ? `<span class="bk-snav-count" title="${escapeHtml(formatMessage(messages['admin.modifiedCount'], { n: count }))}">${count}</span>` : '')
    + `</a>`;
  const sideNav = `<nav class="bk-snav" aria-label="${escapeHtml(messages['admin.settings'])}">`
    + settingSections.map((section) => sectionLink(section, sectionTitles[section], modifiedIn(section))).join('')
    + `<span class="bk-snav-sep" aria-hidden="true"></span>${sectionLink('config', messages['admin.sectionReadonly'])}${sectionLink('history', messages['admin.sectionHistory'])}</nav>`;
  const tabs = `<nav class="bk-tabs" aria-label="${escapeHtml(messages['admin.settings'])}">`
    + settingSections.map((section) => sectionLink(section, sectionTitles[section])).join('')
    + sectionLink('config', messages['admin.sectionReadonly'])
    + sectionLink('history', messages['admin.sectionHistory'])
    + `</nav>`;

  const savedAlert = saved ? `<p class="bk-alert bk-alert--ok" role="status">${escapeHtml(messages['admin.saved'])}</p>` : '';
  const errorAlert = error?.field === 'partner_offers'
    ? `<p class="bk-alert bk-alert--danger" role="alert">${escapeHtml(messages['admin.errorPartnerOffers'])}</p>`
    : adminErrorAlert(messages, error, (field) => {
      const definition = definitions.find((candidate) => candidate.key === field);
      return definition ? labelFor(definition) : undefined;
    });
  return pageShell({
    lang: locale,
    page: 'settings',
    title: `${messages['admin.settings']} — ${context.config.business.name}`,
    cssHref: cssAssetHref(context.routeConfig.paths.assetsCss, context.config.ui?.branding),
    favicon: context.config.ui?.faviconUrl,
    headHtml: context.config.ui?.headHtml,
    scriptHref: jsAssetHref(context.routeConfig.paths.assetsJs),
    topbar: adminTopbar(context, messages, 'settings', openIncidentCount),
    skipLabel: messages['common.skipContent'],
    theme: context.viewerTheme,
    themeToggle: themeToggle(messages, context.viewerTheme),
    body: `<header class="bk-admin-header"><h1>${escapeHtml(messages['admin.settings'])}</h1></header>`
      + savedAlert
      + errorAlert
      + `<div class="bk-settings-layout">${sideNav}<div class="bk-settings-main">${tabs}`
      + `<div class="bk-settings-sections">${sections}${readonlySection}${historySection}</div></div></div>`,
  });
}
