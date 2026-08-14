// Browser-side progressive enhancement for the manage page's reschedule form, shipped as a string
// and served (concatenated after cally's bundle) from the assetsJs route. The page stays fully
// functional without it — the native datetime-local input remains the no-JS fallback and is only
// hidden once the calendar successfully renders. Wrapped in an IIFE so its names can never collide
// with cally's module-scope identifiers in the concatenated file.

export const manageEnhancerJs = `(() => {
  const form = document.querySelector('[data-bookkit-reschedule]');
  if (!form || !('customElements' in window)) return;
  const ds = form.dataset;
  const input = form.querySelector('input[name="newStart"]');
  const nativeField = form.querySelector('[data-bookkit-native-start]');
  const submit = form.querySelector('button[type="submit"]');
  const island = form.querySelector('[data-bookkit-i18n]');
  if (!input || !nativeField || !submit || !ds.endpoint) return;
  let i18n = {};
  try { i18n = JSON.parse(island ? island.textContent : '{}'); } catch {}

  // UTC getters, not local: cally hands isDateDisallowed dates built with Date.UTC, so local
  // getters would read back the previous day in any timezone behind UTC (same bug as the widget's
  // dateKey — see BookingWidget.astro).
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
  calendar.setAttribute('locale', ds.locale || 'pt-PT');
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
      time.textContent = slot.start.slice(11, 16);
      button.append(time);
      if (slot.remainingBookings > 0 && slot.remainingBookings <= 3 && i18n.limited) {
        const hint = document.createElement('span');
        hint.className = 'bk-slot-hint';
        hint.textContent = i18n.limited.replace('{n}', String(slot.remainingBookings));
        button.append(hint);
      }
      button.addEventListener('click', () => {
        for (const other of slots.querySelectorAll('.bk-slot')) other.setAttribute('aria-pressed', 'false');
        button.setAttribute('aria-pressed', 'true');
        // The POST handler expects a business-local YYYY-MM-DDTHH:MM; availability slot starts
        // are local ISO strings with an offset, so the first 16 chars are exactly that.
        input.value = slot.start.slice(0, 16);
        status.textContent = '';
        submit.disabled = false;
      });
      slots.append(button);
    }
  };

  const query = new URLSearchParams({ tour: ds.tour || '', people: ds.people || '', from: ds.from || '', to: ds.to || '' });
  fetch(ds.endpoint + '?' + query, { cache: 'no-store' })
    .then((response) => response.json().then((payload) => ({ ok: response.ok, payload })))
    .then(({ ok, payload }) => {
      if (!ok || !payload.days) throw new Error();
      const days = new Map(payload.days.map((day) => [day.date, day]));
      nativeField.hidden = true;
      input.type = 'hidden';
      input.required = false;
      submit.disabled = true;
      nativeField.before(wrap);
      calendar.isDateDisallowed = (date) => {
        const day = days.get(dateKey(date));
        return !day || day.slots.length === 0;
      };
      const firstOpen = payload.days.find((day) => day.slots.length > 0);
      if (firstOpen) {
        calendar.focusedDate = firstOpen.date;
        status.textContent = i18n.pickDate || '';
      } else {
        status.textContent = i18n.noSlots || '';
      }
      calendar.addEventListener('change', () => renderSlots(days.get(calendar.value)));
    })
    .catch(() => {
      // Leave the native input in place: worst case the page behaves exactly as before.
    });
})();
`;
