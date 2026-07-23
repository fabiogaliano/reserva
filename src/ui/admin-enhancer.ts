// Browser-side progressive enhancement for the admin availability calendar, served (after the
// manage enhancer) from the assetsJs route. Without it, day cells are links that reload the page
// with the form prefilled, months render stacked (far ones collapsed), and the To-date field
// covers contiguous bulk edits. This upgrades that baseline to: a one-month pager with prev/next
// buttons, instant in-page day selection (click to prefill, shift-click range, ctrl/cmd-click to
// toggle scattered days), and a day panel listing the selected day's bookings from the JSON
// island. Multi-day submits travel as repeated hidden date inputs, which the POST handler accepts
// with or without this script. IIFE so nothing leaks into the concatenated bundle.

export const adminEnhancerJs = `(() => {
  const form = document.getElementById('bk-override');
  const monthsBox = document.querySelector('.bk-months');
  if (!form || !monthsBox) return;
  const dateInput = form.querySelector('input[name="date"]');
  const toField = form.querySelector('[data-bookkit-to]');
  const toInput = form.querySelector('input[name="toDate"]');
  const capacityInput = form.querySelector('input[name="capacity"]');
  const reasonDetails = form.querySelector('details');
  const reasonInput = form.querySelector('input[name="reason"]');
  const closeButton = form.querySelector('button[value="close"]');
  const title = form.querySelector('[data-bookkit-day-title]');
  const detail = form.querySelector('[data-bookkit-day-detail]');
  const island = form.querySelector('[data-bookkit-i18n]');
  if (!dateInput || !capacityInput) return;
  let i18n = {};
  try { i18n = JSON.parse(island ? island.textContent : '{}'); } catch {}
  const dayData = i18n.days || {};
  const closeLabel = closeButton ? closeButton.textContent : '';

  // --- month pager: one month visible at a time, prev/next buttons ---
  const monthEls = [...monthsBox.querySelectorAll('.bk-month')];
  if (monthEls.length > 1) {
    const pager = document.createElement('div');
    pager.className = 'bk-pager';
    const mkButton = (label, glyph) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'bk-btn bk-btn--secondary bk-btn--sm';
      button.setAttribute('aria-label', label || '');
      button.textContent = glyph;
      return button;
    };
    const prev = mkButton(i18n.prevMonth, '\\u2039');
    const pagerTitle = document.createElement('h3');
    const next = mkButton(i18n.nextMonth, '\\u203a');
    pager.append(prev, pagerTitle, next);
    monthsBox.insertBefore(pager, monthsBox.firstChild);
    for (const el of monthEls) {
      if (el.tagName === 'DETAILS') el.open = true;
      const heading = el.querySelector('summary, h3');
      if (heading) heading.hidden = true;
    }
    let active = Math.max(0, monthEls.findIndex((el) => el.querySelector('[aria-current="date"]')));
    const show = (index) => {
      active = Math.min(Math.max(index, 0), monthEls.length - 1);
      monthEls.forEach((el, idx) => { el.hidden = idx !== active; });
      pagerTitle.textContent = monthEls[active].dataset.label || '';
      prev.disabled = active === 0;
      next.disabled = active === monthEls.length - 1;
    };
    prev.addEventListener('click', () => show(active - 1));
    next.addEventListener('click', () => show(active + 1));
    show(active);
  }

  // --- day selection + form prefill + day panel ---
  const cells = new Map();
  monthsBox.querySelectorAll('.bk-day[data-date]').forEach((cell) => cells.set(cell.dataset.date, cell));
  let selected = dateInput.value && cells.has(dateInput.value) ? [dateInput.value] : [];
  let anchor = selected[0] || null;

  const renderDetail = (date) => {
    if (!detail) return;
    detail.textContent = '';
    if (!date) return;
    const rows = dayData[date] || [];
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'bk-hint';
      empty.textContent = i18n.noBookings || '';
      detail.appendChild(empty);
      return;
    }
    const list = document.createElement('ul');
    list.className = 'bk-day-bookings';
    for (const row of rows) {
      const item = document.createElement('li');
      const time = document.createElement('span');
      time.className = 'bk-mono';
      time.textContent = row.t;
      const name = document.createElement('strong');
      name.textContent = row.c;
      const people = document.createElement('span');
      people.className = 'bk-sub';
      people.textContent = row.p;
      const status = document.createElement('span');
      status.className = 'bk-badge' + (row.sc ? ' bk-badge--' + row.sc : '');
      status.textContent = row.s;
      // BK-SEC-002: row.u is only present when the server found a presentable operator token
      // (src/handlers/index.ts manageLinkHref) -- otherwise render plain text, never a link that
      // would 403 the instant it's clicked.
      let manage;
      if (row.u) {
        manage = document.createElement('a');
        manage.href = row.u;
        manage.textContent = i18n.manage || '';
      } else {
        manage = document.createElement('span');
        manage.className = 'bk-sub';
        manage.textContent = i18n.manageUnavailable || '';
      }
      item.append(time, name, people, status, manage);
      list.appendChild(item);
    }
    detail.appendChild(list);
  };

  const sync = () => {
    const sorted = [...selected].sort();
    form.querySelectorAll('input[data-bookkit-extra-date]').forEach((input) => input.remove());
    if (sorted.length) dateInput.value = sorted[0];
    for (const date of sorted.slice(1)) {
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.name = 'date';
      hidden.value = date;
      hidden.setAttribute('data-bookkit-extra-date', '');
      form.appendChild(hidden);
    }
    if (toInput) toInput.value = '';
    cells.forEach((cell, date) => {
      cell.classList.toggle('bk-day--selected', sorted.includes(date));
      if (sorted.length === 1 && date === sorted[0]) cell.setAttribute('aria-current', 'date');
      else cell.removeAttribute('aria-current');
    });
    if (sorted.length === 1) {
      const cell = cells.get(sorted[0]);
      if (title && cell) title.textContent = cell.getAttribute('aria-label') || sorted[0];
      if (closeButton) closeButton.textContent = i18n.close || closeLabel;
      renderDetail(sorted[0]);
      if (cell) {
        capacityInput.value = cell.dataset.capacity || '';
        if (reasonInput) reasonInput.value = cell.dataset.reason || '';
        if (reasonDetails) reasonDetails.open = !!cell.dataset.reason;
      }
    } else if (sorted.length > 1) {
      if (title) title.textContent = (i18n.selectedDays || '{n} days selected').replace('{n}', sorted.length);
      if (closeButton && i18n.closeMany) closeButton.textContent = i18n.closeMany.replace('{n}', sorted.length);
      renderDetail(null);
    } else {
      if (title) title.textContent = i18n.title || '';
      if (closeButton) closeButton.textContent = i18n.close || closeLabel;
      renderDetail(null);
    }
  };

  monthsBox.addEventListener('click', (event) => {
    const cell = event.target.closest('.bk-day[data-date]');
    if (!cell) return;
    event.preventDefault();
    const date = cell.dataset.date;
    if (event.shiftKey && anchor) {
      const range = [anchor, date].sort();
      selected = [...cells.keys()].filter((key) => key >= range[0] && key <= range[1]);
    } else if (event.metaKey || event.ctrlKey) {
      selected = selected.includes(date) ? selected.filter((key) => key !== date) : [...selected, date];
      anchor = date;
    } else {
      selected = [date];
      anchor = date;
    }
    sync();
  });

  // Multi-select supersedes the contiguous-range field; hiding it keeps one selection model.
  if (toField) toField.hidden = true;
})();
`;
