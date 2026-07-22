// Browser-side progressive enhancement for the admin settings tabs, served from the assetsJs
// route. Tabs are plain ?section= links that reload the page; this intercepts them to toggle the
// already-rendered panels in place and keeps the URL in sync so refresh and copy-link still land
// on the same tab. IIFE so nothing leaks into the concatenated bundle.

export const settingsEnhancerJs = `(() => {
  const tabs = document.querySelector('.bk-tabs');
  const panels = document.querySelector('.bk-settings-sections');
  if (!tabs || !panels) return;
  tabs.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-bookkit-tab]');
    if (!link) return;
    event.preventDefault();
    tabs.querySelectorAll('a[data-bookkit-tab]').forEach((tab) => {
      if (tab === link) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });
    for (const panel of panels.children) panel.hidden = panel.id !== 'bk-s-' + link.dataset.bookkitTab;
    history.replaceState(null, '', link.href);
  });
})();
`;
