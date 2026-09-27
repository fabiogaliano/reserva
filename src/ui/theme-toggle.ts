// Browser-side progressive enhancement for the per-viewer theme switch. The server renders it
// hidden with the current choice pressed; without this script it stays hidden, so no-JS viewers
// get the OS default. A click applies the choice at once and persists it to the cookie.

export const themeToggleJs = `(() => {
  const group = document.querySelector('[data-reserva-theme-toggle]');
  if (!group) return;
  const buttons = [...group.querySelectorAll('button[value]')];

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
  };

  group.addEventListener('click', (event) => {
    const button = event.target.closest('button[value]');
    if (button) choose(button.value);
  });
  group.hidden = false;
})();
`;
