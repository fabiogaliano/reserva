import { adminLocaleFor } from '../../core/config.js';
import { minorUnitDigits, toMajorUnits } from '../../core/currency.js';
import {
  settingDefinitionsFor,
  settingSections,
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

// The admin settings page (?view=settings). Each setting reads as a statement about the business
// with its value in the sentence; the control only appears once the operator clicks Change. The
// server renders sentence and control together, so with scripting off the page is a plain form —
// the enhancer is what collapses the controls. Sections sit behind a tab bar that degrades to
// links. csrfToken is undefined when CSRF isn't configured.
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
    context.config.services[serviceSlug]?.schedule[ruleIndex] ?? rule;
  // A schedule rule's heading names the service and, for a seasonal rule, the window it covers.
  // The days it runs are a statement inside the group, not part of its title.
  const scheduleRuleHeading = (group: ScheduleRuleGroup): string => {
    const rule = ruleFor(group);
    return rule.from || rule.to
      ? formatMessage(messages['settingGroup.scheduleRuleSeason'], { service: group.serviceTitle, from: monthDayName(rule.from ?? '01-01'), to: monthDayName(rule.to ?? '12-31') })
      : group.serviceTitle;
  };
  // A tier's own description, since its label can't be a static message key: the quantity band and,
  // where the service has a pickup axis, the pickup option's own copy (same fallbacks as the catalog).
  const pricingTierLabel = ({ rule, service }: PricingTierGroup): string => {
    const option = service.location?.pickupOptions.find((candidate) => candidate.id === rule.pickup);
    if (!option) return formatMessage(messages['setting.priceTierNoPickup'], { n: rule.maxQuantity });
    const pickup = option.label
      ?? (option.id === 'default' ? messages['widget.pickupDefault'] : option.id === 'custom' ? messages['widget.pickupCustom'] : option.id);
    return formatMessage(messages['setting.priceTier'], { n: rule.maxQuantity, pickup });
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
  const labelFor = (definition: SettingDefinition): string =>
    definition.pricingTier ? pricingTierLabel(definition.pricingTier) : catalog[definition.labelKey] ?? definition.key;

  // The bare control for one definition, without the statement chrome around it.
  const controlMarkup = (definition: SettingDefinition): string => {
    const label = labelFor(definition);
    const effective = definition.get(context.config);
    const kind = definition.kind;
    if (kind.type === 'boolean') {
      return `<label class="bk-switch"><input type="checkbox" name="${escapeHtml(definition.key)}"${effective ? ' checked' : ''}><span>${escapeHtml(label)}</span></label>`;
    }
    if (kind.type === 'days') {
      const selected = Array.isArray(effective) ? effective : [];
      const boxes = WEEKDAY_ORDER.map((day) =>
        `<label class="bk-check"><input type="checkbox" name="${escapeHtml(definition.key)}" value="${day}"${selected.includes(day) ? ' checked' : ''}><span>${escapeHtml(weekdayName(day))}</span></label>`).join('');
      return `<fieldset class="bk-fieldset"><legend class="bk-sr-only">${escapeHtml(label)}</legend><div class="bk-days">${boxes}</div></fieldset>`;
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
    return `<label class="bk-field"><span>${escapeHtml(label)}</span><input class="bk-input" type="${inputType}" name="${escapeHtml(definition.key)}" value="${escapeHtml(value)}"${constraints}></label>`;
  };

  // A value that deviates from the file config carries a badge on the sentence, and its own
  // "what it falls back to" note plus Reset next to the control in the editor — one statement can
  // cover three fields, so a single shared Reset there would be ambiguous about what it resets.
  const overriddenIn = (group: SettingDefinition[]): SettingDefinition[] =>
    group.filter((definition) => storedRows[definition.key] !== undefined);
  const modifiedBadge = (group: SettingDefinition[]): string =>
    overriddenIn(group).length === 0
      ? ''
      : `<span class="bk-badge bk-badge--accent">${escapeHtml(messages['admin.modified'])}</span>`;
  // The reset button sits outside any <label> so clicking it never toggles the control it belongs to.
  const resetMarkup = (definition: SettingDefinition): string => {
    if (storedRows[definition.key] === undefined) return '';
    return `<span class="bk-modified">`
      + `<span>${escapeHtml(formatMessage(messages['admin.default'], { v: displayValue(definition, definition.get(base)) }))}</span>`
      + `<button type="submit" class="bk-linkbtn" name="action" value="settings-reset:${escapeHtml(definition.key)}" formnovalidate>${escapeHtml(messages['admin.resetField'])}</button>`
      + `</span>`;
  };

  // One statement row: the sentence, a Change button, and the controls it reveals. `group` is the
  // set of definitions the sentence covers, so a combined statement resets and edits all of them.
  // Every Change button reads the same, so it points at its own sentence: a screen reader tabbing
  // through the section otherwise hears twenty identical buttons with no way to tell them apart.
  let statementCount = 0;
  const statement = (sentenceHtml: string, group: SettingDefinition[]): string => {
    const hints = group.map((definition) => catalog[`${definition.labelKey}.hint`]).filter(Boolean);
    const hint = hints.length === 1 ? `<span class="bk-hint">${escapeHtml(hints[0] as string)}</span>` : '';
    statementCount += 1;
    const sentenceId = `bk-stmt-${statementCount}`;
    return `<div class="bk-stmt">`
      + `<span class="bk-stmt-text" id="${sentenceId}">${sentenceHtml}</span>`
      + `<button type="button" class="bk-stmt-edit" data-reserva-stmt-edit aria-describedby="${sentenceId}">${escapeHtml(messages['admin.changeValue'])}</button>`
      + modifiedBadge(group)
      + `<span class="bk-stmt-editor">${group.map((definition) => controlMarkup(definition) + resetMarkup(definition)).join('')}${hint}</span>`
      + `</div>`;
  };

  const plainSentence = (definition: SettingDefinition): string =>
    `${escapeHtml(labelFor(definition))} <b>${escapeHtml(displayValue(definition, definition.get(context.config)))}</b>`;

  // The four opening-hours fields of one schedule rule describe a single fact, so they become one
  // sentence: three time/interval values in one statement and the weekdays in another.
  const scheduleStatements = (group: SettingDefinition[]): string => {
    const byKey = (suffix: string) => group.find((definition) => definition.key.endsWith(`.${suffix}`));
    const first = byKey('firstStart');
    const last = byKey('lastStart');
    const interval = byKey('intervalMin');
    const days = byKey('days');
    if (!first || !last || !interval || !days) return group.map((definition) => statement(plainSentence(definition), [definition])).join('');
    const bold = (definition: SettingDefinition) => `<b>${escapeHtml(displayValue(definition, definition.get(context.config)))}</b>`;
    const departs = formatMessage(escapeHtml(messages['settingStmt.schedule']), {
      from: bold(first), to: bold(last), n: bold(interval),
    });
    const runs = formatMessage(escapeHtml(messages['settingStmt.days']), { days: bold(days) });
    return statement(departs, [first, last, interval]) + statement(runs, [days]);
  };

  const sections = settingSections.map((section) => {
    const sectionDefinitions = definitions.filter((definition) => definition.section === section);
    let body = '';
    let lastGroup: string | undefined;
    for (let index = 0; index < sectionDefinitions.length;) {
      const definition = sectionDefinitions[index] as SettingDefinition;
      const groupTitle = definition.scheduleRule ? scheduleRuleHeading(definition.scheduleRule)
        : definition.pricingTier ? definition.pricingTier.serviceTitle
        : catalog[definition.groupKey ?? ''] ?? definition.groupKey;
      if (definition.groupKey && definition.groupKey !== lastGroup) {
        body += `<h3 class="bk-setting-group">${escapeHtml(groupTitle ?? '')}</h3>`;
      }
      lastGroup = definition.groupKey;
      if (definition.scheduleRule) {
        const run = sectionDefinitions.filter((candidate) => candidate.groupKey === definition.groupKey);
        body += scheduleStatements(run);
        index += run.length;
        continue;
      }
      body += statement(plainSentence(definition), [definition]);
      index += 1;
    }
    const hasOverrides = sectionDefinitions.some((definition) => storedRows[definition.key] !== undefined);
    // formnovalidate on resets: emptied required fields must not block returning to config values.
    const sectionReset = hasOverrides
      ? `<button type="submit" class="bk-linkbtn" name="action" value="settings-reset" formnovalidate>${escapeHtml(messages['admin.resetSection'])}</button>`
      : '';
    return `<form method="post" class="bk-settings-form" id="bk-s-${section}"${section === activeSection ? '' : ' hidden'}><h2>${escapeHtml(sectionTitles[section])}</h2>`
      + `<p class="bk-hint">${escapeHtml(sectionHints[section])}</p>`
      + `<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><input type="hidden" name="section" value="${escapeHtml(section)}">${body}`
      + `<div class="bk-actions bk-actions--split"><button type="submit" class="bk-btn" name="action" value="settings-save">${escapeHtml(messages['admin.save'])}</button>${sectionReset}</div></form>`;
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
