// Browser-side progressive enhancement for the admin settings page. Section links are plain
// ?section= links that reload the page, so this intercepts them to toggle panels in place; and
// since every control is always editable, the only other job is to make an unsaved edit visible:
// on the field, in the save bar, and as a prompt before leaving. IIFE so nothing leaks into the
// concatenated bundle.

export const settingsEnhancerJs = `(() => {
  const panels = document.querySelector('.bk-settings-sections');
  if (!panels) return;

  // The side list and the narrow-screen tab bar carry the same links; both stay in step.
  const sectionLinks = [...document.querySelectorAll('a[data-reserva-tab]')];
  for (const link of sectionLinks) {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      for (const other of sectionLinks) {
        if (other.dataset.reservaTab === link.dataset.reservaTab) other.setAttribute('aria-current', 'page');
        else other.removeAttribute('aria-current');
      }
      for (const panel of panels.children) panel.hidden = panel.id !== 'bk-s-' + link.dataset.reservaTab;
      history.replaceState(null, '', link.href);
    });
  }

  // Save is the step operators miss. A section's bar stays quiet (Save disabled) until something
  // in it changes, then counts the edited fields and offers Discard; an edit also flags its own
  // field, and leaving the page with edits pending asks first.
  const dirtyByForm = new Map();
  const syncBar = (form) => {
    const bar = form.querySelector('.bk-savebar');
    if (!bar) return;
    const count = (dirtyByForm.get(form) || new Set()).size;
    const save = bar.querySelector('button[value="settings-save"]');
    const discard = bar.querySelector('[data-reserva-discard]');
    const message = bar.querySelector('[data-reserva-savebar-msg]');
    bar.toggleAttribute('data-dirty', count > 0);
    if (save) save.disabled = count === 0;
    if (discard) discard.hidden = count === 0;
    if (message) {
      message.textContent = count === 0
        ? bar.dataset.lClean || ''
        : count === 1 ? bar.dataset.lOne || '' : (bar.dataset.lMany || '').replace('{n}', String(count));
    }
  };
  // A {v} hint restates the value; keep it in step with the field it describes.
  const syncLive = (field, control) => {
    for (const live of field.querySelectorAll('[data-reserva-live]')) live.textContent = control.value || '0';
  };
  panels.addEventListener('input', (event) => {
    const control = event.target;
    if (!control.name || control.type === 'hidden') return;
    const field = control.closest('.bk-sfield');
    const form = control.closest('form');
    if (!field || !form) return;
    field.setAttribute('data-bk-dirty', '');
    field.querySelector('.bk-sfield-dirty')?.removeAttribute('hidden');
    syncLive(field, control);
    if (!dirtyByForm.has(form)) dirtyByForm.set(form, new Set());
    dirtyByForm.get(form).add(control.name);
    syncBar(form);
  });
  // Discard is a native reset; the flags come off once the controls hold their loaded values again.
  panels.addEventListener('reset', (event) => {
    const form = event.target;
    setTimeout(() => {
      for (const field of form.querySelectorAll('.bk-sfield[data-bk-dirty]')) {
        field.removeAttribute('data-bk-dirty');
        field.querySelector('.bk-sfield-dirty')?.setAttribute('hidden', '');
        const control = field.querySelector('input[name]');
        if (control) syncLive(field, control);
      }
      dirtyByForm.delete(form);
      syncBar(form);
    });
  });
  panels.addEventListener('submit', (event) => dirtyByForm.delete(event.target));
  for (const form of panels.querySelectorAll('form')) syncBar(form);
  window.addEventListener('beforeunload', (event) => {
    if ([...dirtyByForm.values()].every((names) => names.size === 0)) return;
    event.preventDefault();
    event.returnValue = '';
  });
})();
`;
