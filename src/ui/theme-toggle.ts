// Browser-side progressive enhancement for the per-viewer theme toggle. Server renders it hidden
// with the current mode; without this script it stays hidden, so no-JS viewers get the OS
// default. Click cycles System → Light → Dark and persists the choice to the cookie.

export const themeToggleJs = `(() => {
  const button = document.querySelector('[data-reserva-theme-toggle]');
  if (!button) return;
  const ds = button.dataset;
  const modes = ['system', 'light', 'dark'];
  const labels = { system: ds.lSystem || 'System', light: ds.lLight || 'Light', dark: ds.lDark || 'Dark' };
  let mode = modes.indexOf(ds.mode || 'system') >= 0 ? ds.mode : 'system';

  const render = () => {
    button.replaceChildren();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('aria-hidden', 'true');
    // A half-filled circle: the conventional "appearance" glyph. Stays constant across modes — the
    // label text carries the current choice, so the icon just marks the control.
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    ring.setAttribute('cx', '12');
    ring.setAttribute('cy', '12');
    ring.setAttribute('r', '9');
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', 'currentColor');
    ring.setAttribute('stroke-width', '2');
    const half = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    half.setAttribute('d', 'M12 3a9 9 0 010 18z');
    half.setAttribute('fill', 'currentColor');
    svg.append(ring, half);
    const text = document.createElement('span');
    text.textContent = labels[mode];
    button.append(svg, text);
    button.setAttribute('aria-label', (ds.aria || 'Theme') + ': ' + labels[mode]);
  };

  const apply = () => {
    const root = document.documentElement;
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
  };

  const persist = () => {
    if (mode === 'system') document.cookie = 'bk_theme=; path=/; max-age=0; samesite=lax';
    else document.cookie = 'bk_theme=' + mode + '; path=/; max-age=31536000; samesite=lax';
  };

  button.addEventListener('click', () => {
    mode = modes[(modes.indexOf(mode) + 1) % modes.length];
    apply();
    persist();
    render();
  });

  button.hidden = false;
  render();
})();
`;
