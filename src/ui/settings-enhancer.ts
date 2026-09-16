// Browser-side progressive enhancement for the admin settings page. Two jobs: tabs are plain
// ?section= links that reload the page, so this intercepts them to toggle panels in place; and
// each setting's control is collapsed behind its sentence, which only this script can do — the
// server has to render both so the page still works as a form with scripting off.
// IIFE so nothing leaks into the concatenated bundle.

export const settingsEnhancerJs = `(() => {
  const panels = document.querySelector('.bk-settings-sections');
  if (!panels) return;
  // The stylesheet keys every collapse rule off this attribute, so the controls stay visible for
  // anyone who never runs this script.
  document.documentElement.setAttribute('data-bk-js', '');

  const tabs = document.querySelector('.bk-tabs');
  if (tabs) {
    tabs.addEventListener('click', (event) => {
      const link = event.target.closest('a[data-reserva-tab]');
      if (!link) return;
      event.preventDefault();
      tabs.querySelectorAll('a[data-reserva-tab]').forEach((tab) => {
        if (tab === link) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
      });
      for (const panel of panels.children) panel.hidden = panel.id !== 'bk-s-' + link.dataset.reservaTab;
      history.replaceState(null, '', link.href);
    });
  }

  // Opening a statement swaps the sentence for its controls and moves focus into the first one, so
  // the click and the keyboard land in the same place. Only one statement is open at a time: the
  // point of the sentence view is that the page is mostly prose.
  panels.addEventListener('click', (event) => {
    const button = event.target.closest('[data-reserva-stmt-edit]');
    if (!button) return;
    const statement = button.closest('.bk-stmt');
    if (!statement) return;
    for (const other of panels.querySelectorAll('.bk-stmt[data-bk-open]')) {
      if (other !== statement) other.removeAttribute('data-bk-open');
    }
    statement.setAttribute('data-bk-open', '');
    const field = statement.querySelector('input:not([type=hidden]), select, textarea');
    if (field) field.focus();
  });
})();
`;
