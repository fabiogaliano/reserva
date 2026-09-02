// Browser-side progressive enhancement for the admin settings tabs. Tabs are plain ?section=
// links that reload the page; this intercepts them to toggle panels in place and keep the URL in
// sync. IIFE so nothing leaks into the concatenated bundle.

export const settingsEnhancerJs = `(() => {
  const tabs = document.querySelector('.bk-tabs');
  const panels = document.querySelector('.bk-settings-sections');
  if (!tabs || !panels) return;
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
})();
`;
