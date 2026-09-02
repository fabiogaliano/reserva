import { adminLocaleFor } from '../../core/config.js';
import {
  settingDefinitions,
  settingSections,
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

// The admin settings page (?view=settings): grouped sections behind a tab bar (one section on
// screen at a time), single-column fields, switches for booleans, a per-field "Reset" where a
// value deviates from the file config, and a saved confirmation after POST. Tabs degrade to plain
// links without JS. csrfToken is undefined when CSRF isn't configured.
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
  const sectionTitles: Record<SettingSection, string> = {
    policy: messages['admin.sectionPolicy'],
    capacity: messages['admin.sectionCapacity'],
    contact: messages['admin.sectionContact'],
    legal: messages['admin.sectionLegal'],
  };
  const sectionHints: Record<SettingSection, string> = {
    policy: messages['admin.sectionPolicyHint'],
    capacity: messages['admin.sectionCapacityHint'],
    contact: messages['admin.sectionContactHint'],
    legal: messages['admin.sectionLegalHint'],
  };
  const displayValue = (value: SettingValue): string => {
    if (value === null) return messages['admin.none'];
    if (typeof value === 'boolean') return value ? messages['admin.on'] : messages['admin.off'];
    return String(value);
  };

  const fieldMarkup = (definition: SettingDefinition): string => {
    const label = catalog[definition.labelKey] ?? definition.key;
    const helpText = catalog[`${definition.labelKey}.hint`];
    const help = helpText ? `<span class="bk-hint">${escapeHtml(helpText)}</span>` : '';
    const effective = definition.get(context.config);
    // Shown only where a DB override exists; the reset button lives outside the <label> so
    // clicking it never toggles or focuses the control it belongs to.
    const modified = storedRows[definition.key] !== undefined
      ? `<span class="bk-modified"><span class="bk-badge bk-badge--accent">${escapeHtml(messages['admin.modified'])}</span>`
        + `<span>${escapeHtml(formatMessage(messages['admin.default'], { v: displayValue(definition.get(base)) }))}</span>`
        + `<button type="submit" class="bk-linkbtn" name="action" value="settings-reset:${escapeHtml(definition.key)}" formnovalidate>${escapeHtml(messages['admin.resetField'])}</button></span>`
      : '';
    const kind = definition.kind;
    if (kind.type === 'boolean') {
      return `<div class="bk-setting"><label class="bk-switch"><input type="checkbox" name="${escapeHtml(definition.key)}"${effective ? ' checked' : ''}><span>${escapeHtml(label)}</span></label>${help}${modified}</div>`;
    }
    const inputType = kind.type === 'int' || kind.type === 'number' ? 'number' : kind.type === 'email' ? 'email' : kind.type === 'url' ? 'url' : 'text';
    const constraints = kind.type === 'int' ? ` min="${kind.min}"${kind.max !== undefined ? ` max="${kind.max}"` : ''} step="1"${kind.optional ? '' : ' required'}`
      : kind.type === 'number' ? ` min="${kind.min}" step="any" required`
      : kind.type === 'text' && kind.optional ? '' : ' required';
    const value = effective === null ? '' : String(effective);
    return `<div class="bk-setting"><label class="bk-field"><span>${escapeHtml(label)}</span><input class="bk-input" type="${inputType}" name="${escapeHtml(definition.key)}" value="${escapeHtml(value)}"${constraints}></label>${help}${modified}</div>`;
  };

  const sections = settingSections.map((section) => {
    let lastGroup: string | undefined;
    const fields = settingDefinitions.filter((definition) => definition.section === section).map((definition) => {
      const heading = definition.groupKey && definition.groupKey !== lastGroup
        ? `<h3 class="bk-setting-group">${escapeHtml(catalog[definition.groupKey] ?? definition.groupKey)}</h3>`
        : '';
      lastGroup = definition.groupKey;
      return heading + fieldMarkup(definition);
    }).join('');
    const hasOverrides = settingDefinitions.some((definition) => definition.section === section && storedRows[definition.key] !== undefined);
    // formnovalidate on resets: emptied required fields must not block returning to config values.
    const sectionReset = hasOverrides
      ? `<button type="submit" class="bk-linkbtn" name="action" value="settings-reset" formnovalidate>${escapeHtml(messages['admin.resetSection'])}</button>`
      : '';
    return `<form method="post" class="bk-card" id="bk-s-${section}"${section === activeSection ? '' : ' hidden'}><h2>${escapeHtml(sectionTitles[section])}</h2>`
      + `<p class="bk-hint bk-section-hint">${escapeHtml(sectionHints[section])}</p>`
      + `<input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><input type="hidden" name="section" value="${escapeHtml(section)}">${fields}`
      + `<div class="bk-actions bk-actions--split"><button type="submit" class="bk-btn" name="action" value="settings-save">${escapeHtml(messages['admin.save'])}</button>${sectionReset}</div></form>`;
  }).join('');

  // Deploy-time values on their own tab: reference material, not daily controls.
  const readonlySection = `<section class="bk-card" id="bk-s-config"${activeSection === 'config' ? '' : ' hidden'}><h2>${escapeHtml(messages['admin.sectionReadonly'])}</h2>`
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
    body: `<header class="bk-admin-header"><div><p class="bk-eyebrow">${escapeHtml(messages['admin.workspace'])}</p><h1>${escapeHtml(messages['admin.settings'])}</h1><p class="bk-lead">${escapeHtml(messages['admin.settingsHint'])}</p></div></header>`
      + savedAlert
      + tabs
      + `<div class="bk-settings-sections">${sections}${readonlySection}</div>`,
  });
}
