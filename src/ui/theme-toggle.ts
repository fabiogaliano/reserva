// Browser-side progressive enhancement for the per-viewer theme switch. The server renders it
// hidden with the current choice pressed; without this script it stays hidden, so no-JS viewers
// get the OS default. A click applies the choice at once and persists it to the cookie. In the
// narrow top bar the buttons sit in a menu behind a trigger, which mirrors the current mode.

export const themeToggleJs = `(() => {
  const group = document.querySelector('[data-reserva-theme-toggle]');
  if (!group) return;
  const buttons = [...group.querySelectorAll('button[value]')];
  const trigger = group.querySelector('.bk-theme-trigger');
  const isOpen = () => group.hasAttribute('data-open');
  const setOpen = (open) => {
    group.toggleAttribute('data-open', open);
    trigger?.setAttribute('aria-expanded', String(open));
  };

  const choose = (mode) => {
    const root = document.documentElement;
    if (mode === 'system') {
      root.removeAttribute('data-theme');
      document.cookie = 'bk_theme=; path=/; max-age=0; samesite=lax';
    } else {
      root.setAttribute('data-theme', mode);
      document.cookie = 'bk_theme=' + mode + '; path=/; max-age=31536000; samesite=lax';
    }
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.value === mode));
    const icon = buttons.find((button) => button.value === mode)?.querySelector('svg');
    if (trigger && icon) trigger.replaceChildren(icon.cloneNode(true));
  };

  group.addEventListener('click', (event) => {
    if (trigger && event.target.closest('.bk-theme-trigger')) {
      setOpen(!isOpen());
      return;
    }
    const button = event.target.closest('button[value]');
    if (!button) return;
    choose(button.value);
    // The chosen button disappears with the menu, so focus would otherwise drop to the page.
    if (isOpen()) {
      setOpen(false);
      trigger.focus();
    }
  });
  group.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !isOpen()) return;
    setOpen(false);
    trigger.focus();
  });
  document.addEventListener('click', (event) => {
    if (isOpen() && !group.contains(event.target)) setOpen(false);
  });
  group.hidden = false;
})();
`;
