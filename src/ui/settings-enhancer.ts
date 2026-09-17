// Browser-side progressive enhancement for the admin settings page. Tabs are plain ?section=
// links that reload the page, so this intercepts them to toggle panels in place; and since every
// control is always editable, the only other job is to make an unsaved edit visible: on the field,
// beside Save, and as a prompt before leaving. IIFE so nothing leaks into the concatenated bundle.

export const settingsEnhancerJs = `(() => {
  const panels = document.querySelector('.bk-settings-sections');
  if (!panels) return;

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

  // Save is the step operators miss: an edit flags its field and the section's save bar until the
  // save lands, and leaving the page with edits pending asks first.
  const dirtyForms = new Set();
  panels.addEventListener('input', (event) => {
    const control = event.target;
    if (!control.name || control.type === 'hidden') return;
    const field = control.closest('.bk-sfield');
    const form = control.closest('form');
    if (!field || !form) return;
    field.setAttribute('data-bk-dirty', '');
    field.querySelector('.bk-sfield-dirty')?.removeAttribute('hidden');
    form.setAttribute('data-bk-dirty', '');
    form.querySelector('.bk-unsaved')?.removeAttribute('hidden');
    dirtyForms.add(form);
  });
  panels.addEventListener('submit', (event) => dirtyForms.delete(event.target));
  window.addEventListener('beforeunload', (event) => {
    if (dirtyForms.size === 0) return;
    event.preventDefault();
    event.returnValue = '';
  });
})();
`;
