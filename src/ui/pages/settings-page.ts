import { adminLocaleFor, resolveLocalizedText, type ResolvedServiceConfig } from '../../core/config.js';
import { minorUnitDigits, toMajorUnits } from '../../core/currency.js';
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
import { cssAssetHref, jsAssetHref } from '../asset-hrefs.js';
import { factList, pageShell, themeToggle } from '../layout.js';
import { formatMessage, resolveMessages } from '../messages.js';
import { adminSidebar } from './admin-page.js';

// The admin settings page (?view=settings). A two-column form: each group's title on the left,
// its always-editable fields on the right, so the control is the value and there is no reveal
// step. Sections sit behind a tab bar that degrades to links. csrfToken is undefined when CSRF
// isn't configured.
export function settingsPage(context: ReservaContext, storedRows: Record<string, string>, saved: boolean, sectionParam: string, csrfToken: string | undefined): string {
  const locale = adminLocaleFor(context.config);
  const messages = resolveMessages(context.config, locale);
  const catalog = messages as Record<string, string>;
  // Tabs are plain links (?section=) so switching works without JS; the enhancer upgrades them to
  // instant in-page toggles. The section param survives save redirects.
  const activeSection = ([...settingSections, 'config'] as string[]).includes(sectionParam)
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
    new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + day)));
  // Monday-first, the way a week is read here; the config's own indices stay 0 = Sunday.
  const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const dayNames = (days: readonly number[]): string =>
    days.length === 7 ? messages['settingGroup.everyDay'] : [...days].sort((a, b) => a - b).map(weekdayName).join(', ');
  const monthDayName = (monthDay: string): string => {
    const [month = 1, day = 1] = monthDay.split('-').map(Number);
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, month - 1, day)));
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

  // Every control is rendered open: the input is the value. A field that deviates from the file
  // config carries a Modified badge, its fallback, and a Reset; the enhancer adds a "not saved"
  // badge the moment the operator edits it, so the two states never share a look.
  const badgesFor = (definition: SettingDefinition): string =>
    (storedRows[definition.key] !== undefined ? `<span class="bk-badge bk-badge--accent">${escapeHtml(messages['admin.modified'])}</span>` : '')
    + `<span class="bk-badge bk-badge--warn bk-sfield-dirty" hidden>${escapeHtml(messages['admin.unsaved'])}</span>`;
  const controlMarkup = (definition: SettingDefinition): string => {
    const label = labelFor(definition);
    const effective = definition.get(context.config);
    const kind = definition.kind;
    const heading = `<span class="bk-sfield-label">${escapeHtml(label)}${badgesFor(definition)}</span>`;
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
    const value = effective === null ? ''
      : kind.type === 'money' ? majorUnits(effective as number, kind.currency)
      : String(effective);
    const wide = inputType === 'text' || inputType === 'email' || inputType === 'url';
    return `<label class="bk-field">${heading}<input class="bk-input${wide ? ' bk-input--wide' : ''}" type="${inputType}" name="${escapeHtml(definition.key)}" value="${escapeHtml(value)}"${constraints}></label>`;
  };

  // The reset button sits outside any <label> so clicking it never toggles the control it belongs to.
  const resetMarkup = (definition: SettingDefinition): string => {
    if (storedRows[definition.key] === undefined) return '';
    return `<span class="bk-modified">`
      + `<span>${escapeHtml(formatMessage(messages['admin.default'], { v: displayValue(definition, definition.get(base)) }))}</span>`
      + `<button type="submit" class="bk-linkbtn" name="action" value="settings-reset:${escapeHtml(definition.key)}" formnovalidate>${escapeHtml(messages['admin.resetField'])}</button>`
      + `</span>`;
  };

  const fieldMarkup = (definition: SettingDefinition, extraHint = ''): string => {
    const hint = catalog[`${definition.labelKey}.hint`];
    return `<div class="bk-sfield">${controlMarkup(definition)}${resetMarkup(definition)}`
      + (hint ? `<span class="bk-hint">${escapeHtml(hint)}</span>` : '')
      + extraHint
      + `</div>`;
  };

  // One group: its title (and, for a service's own closing-time rule, the departure it derives) on
  // the left, the fields on the right. The title column is the only structure the page has; there
  // are no rules between fields.
  const groupMarkup = (title: string, fields: string, aside = ''): string =>
    `<div class="bk-sgroup"><div class="bk-sgroup-head"><h3>${escapeHtml(title)}</h3>${aside}</div><div class="bk-sgroup-fields">${fields}</div></div>`;

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
    // Save is the step operators miss, so the bar pins to the bottom of the viewport and, once
    // anything changes, says so beside the button.
    return `<form method="post" class="bk-settings-form" id="bk-s-${section}"${section === activeSection ? '' : ' hidden'}><h2>${escapeHtml(sectionTitles[section])}</h2>`
      + `<p class="bk-hint">${escapeHtml(sectionHints[section])}</p>`
      + `<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><input type="hidden" name="section" value="${escapeHtml(section)}">${body}`
      + `<div class="bk-actions bk-actions--split bk-savebar"><span class="bk-savebar-status"><button type="submit" class="bk-btn" name="action" value="settings-save">${escapeHtml(messages['admin.save'])}</button>`
      + `<span class="bk-unsaved" role="status" hidden>${escapeHtml(messages['admin.unsavedHint'])}</span></span>${sectionReset}</div></form>`;
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

  const tabLink = (id: string, label: string): string =>
    `<a href="?view=settings&section=${id}" data-reserva-tab="${id}"${id === activeSection ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;
  const tabs = `<nav class="bk-tabs" aria-label="${escapeHtml(messages['admin.settings'])}">`
    + settingSections.map((section) => tabLink(section, sectionTitles[section])).join('')
    + tabLink('config', messages['admin.sectionReadonly'])
    + `</nav>`;

  const savedAlert = saved ? `<p class="bk-alert bk-alert--ok" role="status">${escapeHtml(messages['admin.saved'])}</p>` : '';
  return pageShell({
    lang: locale,
    title: `${messages['admin.settings']} — ${context.config.business.name}`,
    cssHref: cssAssetHref(context.routeConfig.paths.assetsCss),
    favicon: context.config.ui?.faviconUrl,
    headHtml: context.config.ui?.headHtml,
    scriptHref: jsAssetHref(context.routeConfig.paths.assetsJs),
    sidebar: adminSidebar(context, messages, 'settings'),
    sidebarLabel: messages['admin.navigation'],
    skipLabel: messages['common.skipContent'],
    theme: context.viewerTheme,
    themeToggle: themeToggle(messages, context.viewerTheme),
    body: `<header class="bk-admin-header"><h1>${escapeHtml(messages['admin.settings'])}</h1></header>`
      + savedAlert
      + tabs
      + `<div class="bk-settings-sections">${sections}${readonlySection}</div>`,
  });
}
