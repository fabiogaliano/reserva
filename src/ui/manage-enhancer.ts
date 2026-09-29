// Browser-side progressive enhancement for the manage page. The page stays fully functional
// without it — the native datetime-local input is the no-JS fallback, hidden only once the
// calendar renders, and the server validates every field the enhancer only pre-checks. IIFEs so
// names can't collide with cally's in the concatenated file.

import { MANAGE_TOKEN_HEADER } from '../core/api.js';

export const manageEnhancerJs = `(() => {
  if (!document.body || !document.body.classList.contains('bk-page--manage')) return;

  // One action per click: a second submit while the first is in flight would re-run a cancel or
  // reschedule the first already did. Disabled after the event, so the submission itself proceeds.
  for (const form of document.querySelectorAll('form[method="post"]')) {
    form.addEventListener('submit', () => {
      for (const button of form.querySelectorAll('button[type="submit"]')) {
        button.disabled = true;
        button.setAttribute('data-reserva-busy', '');
      }
    });
  }
  // Back/forward restores the page from the bfcache with the buttons still disabled.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    for (const button of document.querySelectorAll('button[data-reserva-busy]')) {
      button.disabled = false;
      button.removeAttribute('data-reserva-busy');
    }
  });

  // The amount only means something for a partial refund, so it is required exactly then.
  const refund = document.querySelector('select[name="refund"]');
  const amount = document.querySelector('input[name="refundAmount"]');
  if (refund && amount) {
    const sync = () => { amount.required = refund.value === 'partial'; };
    refund.addEventListener('change', sync);
    sync();
  }

  // The notice has been rendered; leaving done/error in the URL would show it again on a reload
  // or in a bookmark, long after the action it describes.
  const url = new URL(location.href);
  if (url.searchParams.has('done') || url.searchParams.has('error')) {
    url.searchParams.delete('done');
    url.searchParams.delete('error');
    history.replaceState(history.state, '', url.toString());
  }
})();

(() => {
  const form = document.querySelector('[data-reserva-reschedule]');
  if (!form || !('customElements' in window)) return;
  const ds = form.dataset;
  const input = form.querySelector('input[name="start"]');
  const nativeField = form.querySelector('[data-reserva-native-start]');
  const submit = form.querySelector('button[type="submit"]');
  const island = form.querySelector('[data-reserva-i18n]');
  if (!input || !nativeField || !submit || !ds.endpoint) return;
  let i18n = {};
  try { i18n = JSON.parse(island ? island.textContent : '{}'); } catch {}

  // A copy of @reservajs/astro/client's dateKey rather than an import: this file is served as a
  // plain script asset with no bundler in front of it, so it cannot resolve a module specifier.
  // UTC getters, not local: cally hands isDateDisallowed dates built with Date.UTC, so local
  // getters would read back the previous day in any timezone behind UTC.
  const dateKey = (date) => date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + String(date.getUTCDate()).padStart(2, '0');

  const chevron = (path) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    svg.append(p);
    return svg;
  };

  const wrap = document.createElement('div');
  wrap.className = 'bk-cal-wrap';
  const calendar = document.createElement('calendar-date');
  calendar.className = 'bk-cal';
  calendar.setAttribute('min', ds.from || '');
  calendar.setAttribute('max', ds.to || '');
  // The page's own language, never a hard-coded one: the manage route renders <html lang> from the
  // booking's locale, and data-locale carries the same value for the form.
  calendar.setAttribute('locale', ds.locale || document.documentElement.lang || 'en');
  const prev = chevron('M15 18l-6-6 6-6');
  prev.slot = 'previous';
  const next = chevron('M9 6l6 6-6 6');
  next.slot = 'next';
  calendar.append(prev, next, document.createElement('calendar-month'));
  const slots = document.createElement('div');
  slots.className = 'bk-slots';
  slots.setAttribute('role', 'group');
  slots.setAttribute('aria-label', i18n.time || '');
  const status = document.createElement('p');
  status.className = 'bk-cal-status';
  status.setAttribute('role', 'status');
  status.textContent = i18n.loading || '';
  wrap.append(calendar, slots, status);

  const renderSlots = (day) => {
    slots.replaceChildren();
    input.value = '';
    submit.disabled = true;
    const list = day && day.slots ? day.slots : [];
    if (list.length === 0) {
      status.textContent = i18n.noSlots || '';
      return;
    }
    status.textContent = i18n.pickTime || '';
    for (const slot of list) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'bk-slot';
      button.setAttribute('aria-pressed', 'false');
      const time = document.createElement('span');
      time.className = 'bk-slot-time';
      time.textContent = slot.time;
      button.append(time);
      // The server already applied the deployment's limitedThreshold, so a non-null remaining IS
      // the scarce case — never re-decided here against a hardcoded threshold.
      if (slot.remaining !== null && i18n.limited) {
        const hint = document.createElement('span');
        hint.className = 'bk-slot-hint';
        const one = slot.remaining === 1 && i18n.limitedOne;
        hint.textContent = one ? i18n.limitedOne : i18n.limited.replace('{n}', String(slot.remaining));
        button.append(hint);
      }
      button.addEventListener('click', () => {
        for (const other of slots.querySelectorAll('.bk-slot')) other.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-pressed', 'true');
        // The POST handler expects a business-local YYYY-MM-DDTHH:MM, which is exactly the
        // date/time pair the availability payload already carries.
        input.value = slot.date + 'T' + slot.time;
        status.textContent = '';
        submit.disabled = false;
      });
      slots.append(button);
    }
  };

  // The form's own token lets availability leave this booking out of the count, so the customer
  // can move within (or next to) the slot they already hold. A header, not a query param, so the
  // token stays out of request logs.
  const tokenInput = form.querySelector('input[name="token"], input[name="operatorToken"]');
  const headers = tokenInput && tokenInput.value ? { '${MANAGE_TOKEN_HEADER}': tokenInput.value } : {};
  const minKey = ds.from || '';
  const maxKey = ds.to || '';
  const days = new Map();
  // One request per calendar month, fetched as the operator pages: a horizon can be hundreds of
  // days, and asking for all of it at once cost the server seconds of CPU for months nobody opens.
  const months = new Map();
  const monthOf = (key) => key.slice(0, 7);
  const nextMonth = (month) => {
    const year = Number(month.slice(0, 4));
    const index = Number(month.slice(5, 7));
    return index === 12 ? (year + 1) + '-01' : year + '-' + String(index + 1).padStart(2, '0');
  };
  const lastDayOf = (month) => month + '-' + String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0');
  const loadMonth = (month) => {
    const cached = months.get(month);
    if (cached) return cached;
    const first = month + '-01';
    const last = lastDayOf(month);
    const from = first < minKey ? minKey : first;
    const to = last > maxKey ? maxKey : last;
    if (from > to) return Promise.resolve([]);
    const query = new URLSearchParams({ serviceSlug: ds.service || '', quantity: ds.quantity || '', from, to });
    const request = fetch(ds.endpoint + '?' + query, { cache: 'no-store', headers })
      .then((response) => response.json().then((payload) => ({ ok: response.ok, payload })))
      .then(({ ok, payload }) => {
        if (!ok || !payload.days) throw new Error();
        for (const day of payload.days) days.set(day.date, day);
        return payload.days;
      });
    months.set(month, request);
    // Forgotten on failure, so paging back to that month tries again.
    request.catch(() => { if (months.get(month) === request) months.delete(month); });
    return request;
  };
  // A fresh function each time: that is what makes cally re-evaluate which days are disabled once
  // another month has arrived.
  const refresh = () => {
    calendar.isDateDisallowed = (date) => {
      const day = days.get(dateKey(date));
      return !day || day.slots.length === 0;
    };
  };
  // The shown month and the next, so paging forward one month never waits on the network.
  const loadAround = (month) => Promise.allSettled([loadMonth(month), loadMonth(nextMonth(month))]).then(refresh);
  const firstOpenFrom = (month) => loadMonth(month).then((list) => {
    const open = list.find((day) => day.slots.length > 0);
    if (open) return open;
    const following = nextMonth(month);
    return following + '-01' <= maxKey ? firstOpenFrom(following) : null;
  });
  if (!minKey || !maxKey) return;
  firstOpenFrom(monthOf(minKey))
    .then((firstOpen) => {
      nativeField.hidden = true;
      input.type = 'hidden';
      input.required = false;
      submit.disabled = true;
      nativeField.before(wrap);
      refresh();
      if (firstOpen) {
        calendar.focusedDate = firstOpen.date;
        status.textContent = i18n.pickDate || '';
      } else {
        status.textContent = i18n.noSlots || '';
      }
      loadAround(monthOf(firstOpen ? firstOpen.date : minKey));
      calendar.addEventListener('change', () => renderSlots(days.get(calendar.value)));
      calendar.addEventListener('focusday', (event) => {
        if (event.detail instanceof Date) loadAround(monthOf(dateKey(event.detail)));
      });
    })
    .catch(() => {
      // Leave the native input in place: worst case the page behaves exactly as before.
    });
})();
`;
