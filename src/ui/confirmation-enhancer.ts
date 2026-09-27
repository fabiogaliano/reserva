// Browser-side progressive enhancement for the confirmation page's pending state. The meta refresh
// stays in the markup as the no-script fallback; when this runs it cancels that refresh and polls
// the status API instead, so the page (and a screen reader's place in it) survives each check.
// IIFE so names can't collide with the other enhancers in the concatenated file.

export const confirmationEnhancerJs = `(() => {
  const root = document.querySelector('[data-reserva-status-poll]');
  if (!root || !('fetch' in window)) return;
  const ds = root.dataset;
  const live = root.querySelector('[data-reserva-poll-live]');
  const max = Number(ds.max) || 0;
  let attempt = Number(ds.attempt) || 0;
  if (!ds.endpoint || !ds.sessionId || !max) return;

  // Same URL, new attempt count: the server renders the final state (or the timeout page once the
  // budget is spent) exactly as the meta refresh would have.
  const reload = (next) => {
    const url = new URL(location.href);
    url.searchParams.set('attempt', String(next));
    location.replace(url.toString());
  };
  const say = (text) => { if (live && text && live.textContent !== text) live.textContent = text; };

  const poll = () => {
    attempt += 1;
    const query = new URLSearchParams({ sessionId: ds.sessionId });
    fetch(ds.endpoint + '?' + query, { cache: 'no-store', headers: { accept: 'application/json' } })
      .then((response) => response.ok ? response.json() : null)
      // A failed or non-JSON answer is a server hiccup, not news about the booking: keep waiting.
      .catch(() => null)
      .then((payload) => {
        if (payload && payload.status && payload.status !== 'pending') {
          say(ds.lUpdated);
          reload(0);
          return;
        }
        if (attempt >= max) {
          reload(max);
          return;
        }
        say(ds.lChecking);
        setTimeout(poll, 3000);
      });
  };

  // window.stop() is what cancels a scheduled meta refresh; removing the element does not. Run
  // after load so it cannot abort the page's own stylesheet or images mid-flight.
  const start = () => {
    const refresh = document.querySelector('meta[http-equiv="refresh"]');
    if (refresh) {
      window.stop();
      refresh.remove();
    }
    setTimeout(poll, 3000);
  };
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
})();
`;
