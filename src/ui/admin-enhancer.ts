// Browser-side progressive enhancement for the admin availability calendar, served (after the
// manage enhancer) from the assetsJs route. Without it, day cells are links that reload the page
// with the form prefilled, months render stacked (far ones collapsed), and there is no in-page
// multi-day selection at all — every bulk edit needs the "To date" field. This upgrades that
// baseline to: a one-month pager with prev/next buttons, instant in-page day selection (click to
// prefill, shift-click/-Enter range, ctrl/cmd-click/-Enter/-Space to toggle scattered days), and a
// day panel listing the selected day's bookings from the JSON island.
//
// Plan 014 item D: the "To date" field stays visible (not hidden) in enhanced mode — a contiguous
// selection (pointer or keyboard) syncs it, and typing into either date field updates the enhanced
// selection right back, so pointer, keyboard, and the native inputs can never drift from each
// other. A scattered (non-contiguous) selection travels as repeated hidden date fields with toDate
// explicitly blanked; handleAdminPost (src/handlers/index.ts) unions repeated `date` fields with
// any toDate expansion, so these two submission shapes must never both be populated at once —
// applySelection always clears the other shape's fields before writing its own. Day cells gain
// toggle-button semantics (role="button", aria-pressed) since they're no longer simple navigating
// links once this script takes over, and the day title becomes a role="status" live region so a
// screen reader hears the selection count change without focus ever needing to move. IIFE so
// nothing leaks into the concatenated bundle.

export const adminEnhancerJs = `(() => {
  const form = document.getElementById('bk-override');
  const monthsBox = document.querySelector('.bk-months');
  if (!form || !monthsBox) return;
  const dateInput = form.querySelector('input[name="date"]');
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
    pagerTitle.setAttribute('aria-live', 'polite');
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

  // A visible hint before the calendar: Shift/Ctrl/Cmd-click and the Space toggle only exist once
  // this script is running, so no-JS markup never mentions them.
  if (i18n.selectHint) {
    const hint = document.createElement('p');
    hint.className = 'bk-hint bk-selection-hint';
    hint.setAttribute('data-bookkit-select-hint', '');
    hint.textContent = i18n.selectHint;
    const firstMonth = monthsBox.querySelector('.bk-month');
    monthsBox.insertBefore(hint, firstMonth);
  }

  // --- day selection + form prefill + day panel ---
  const cells = new Map();
  monthsBox.querySelectorAll('.bk-day[data-date]').forEach((cell) => {
    cells.set(cell.dataset.date, cell);
    // No longer a plain navigating link once this script takes over — removing href (not just
    // intercepting click) is required, not cosmetic: a browser opens ctrl/cmd-click on an
    // <a href> as a new background tab at the browser-chrome level, before any page JS ever sees a
    // click event, so preventDefault() on 'click' cannot stop it and the toggle gesture would
    // silently never fire. Losing href also loses the anchor's native tab-stop and
    // Enter-activates-click behavior, so both are restored explicitly (tabIndex, and the keydown
    // listener below handles Enter and Space alike).
    cell.removeAttribute('href');
    cell.tabIndex = 0;
    cell.setAttribute('role', 'button');
    // aria-pressed starts from the server-rendered selected class, since the no-JS markup already
    // reflects the initial (single) selection correctly.
    cell.setAttribute('aria-pressed', String(cell.classList.contains('bk-day--selected')));
  });
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

  // Reflects \`selected\` onto the calendar cells and the day panel (title/detail/capacity
  // prefill). Shared by every path that can change \`selected\` — pointer clicks, Space, and typing
  // directly into the date/toDate inputs — so all three stay visually and semantically in sync.
  // Returns the sorted selection so callers that also need to rewrite the form fields don't
  // recompute it.
  const renderCells = () => {
    const sorted = [...selected].sort();
    cells.forEach((cell, date) => {
      const isSelected = sorted.includes(date);
      cell.classList.toggle('bk-day--selected', isSelected);
      cell.setAttribute('aria-pressed', String(isSelected));
      if (sorted.length === 1 && date === sorted[0]) cell.setAttribute('aria-current', 'date');
      else cell.removeAttribute('aria-current');
    });
    if (sorted.length === 1) {
      const cell = cells.get(sorted[0]);
      if (title && cell) title.textContent = cell.getAttribute('aria-label') || sorted[0];
      else if (title) title.textContent = sorted[0];
      if (closeButton) closeButton.textContent = i18n.close || closeLabel;
      renderDetail(sorted[0]);
      if (cell) {
        capacityInput.value = cell.dataset.capacity || '';
        if (reasonInput) reasonInput.value = cell.dataset.reason || '';
        if (reasonDetails) reasonDetails.open = !!cell.dataset.reason;
      }
    } else if (sorted.length > 1) {
      // role="status" on the title (server markup) makes this an accessible live-region
      // announcement of the selection count, without moving focus.
      if (title) title.textContent = (i18n.selectedDays || '{n} days selected').replace('{n}', sorted.length);
      if (closeButton && i18n.closeMany) closeButton.textContent = i18n.closeMany.replace('{n}', sorted.length);
      renderDetail(null);
    } else {
      if (title) title.textContent = i18n.title || '';
      if (closeButton) closeButton.textContent = i18n.close || closeLabel;
      renderDetail(null);
    }
    return sorted;
  };

  const isContiguous = (sorted) => {
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = Date.parse(sorted[i - 1] + 'T00:00:00Z');
      const cur = Date.parse(sorted[i] + 'T00:00:00Z');
      if (cur - prev !== 86400000) return false;
    }
    return true;
  };

  // Rewrites the form's submission shape from \`selected\`: a contiguous run travels as
  // date+toDate (the same shape the no-JS bulk path already produces), a scattered set travels as
  // repeated hidden date fields with toDate explicitly blanked so it never falsely implies a
  // contiguous range covering the gaps. Always clears the other shape's fields first, so a pointer/
  // keyboard selection can never leave behind a stale field from an earlier selection.
  const applySelection = () => {
    const sorted = renderCells();
    form.querySelectorAll('input[data-bookkit-extra-date]').forEach((input) => input.remove());
    if (sorted.length === 0) {
      dateInput.value = '';
      if (toInput) toInput.value = '';
      return;
    }
    dateInput.value = sorted[0];
    if (sorted.length > 1 && isContiguous(sorted)) {
      if (toInput) toInput.value = sorted[sorted.length - 1];
    } else {
      if (toInput) toInput.value = '';
      for (const date of sorted.slice(1)) {
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = 'date';
        hidden.value = date;
        hidden.setAttribute('data-bookkit-extra-date', '');
        form.appendChild(hidden);
      }
    }
  };

  const selectDate = (date, mode) => {
    if (mode === 'range' && anchor) {
      const range = [anchor, date].sort();
      selected = [...cells.keys()].filter((key) => key >= range[0] && key <= range[1]);
    } else if (mode === 'toggle') {
      selected = selected.includes(date) ? selected.filter((key) => key !== date) : [...selected, date];
      anchor = date;
    } else {
      selected = [date];
      anchor = date;
    }
    applySelection();
  };

  // Shared by both the click and keydown handlers so pointer and keyboard activation always agree
  // on what a given modifier combination means.
  const modeFromEvent = (event) => (event.shiftKey ? 'range' : (event.metaKey || event.ctrlKey) ? 'toggle' : 'replace');

  monthsBox.addEventListener('click', (event) => {
    const cell = event.target.closest('.bk-day[data-date]');
    if (!cell) return;
    selectDate(cell.dataset.date, modeFromEvent(event));
  });

  // href is gone (see above), so neither Enter nor Space is wired by the browser for free anymore
  // — both are handled here, sharing the same modifier-based mode as a click (e.g. Shift+Enter is
  // a range, same as shift-click).
  monthsBox.addEventListener('keydown', (event) => {
    if (event.key !== ' ' && event.key !== 'Spacebar' && event.key !== 'Enter') return;
    const cell = event.target.closest('.bk-day[data-date]');
    if (!cell) return;
    event.preventDefault();
    selectDate(cell.dataset.date, modeFromEvent(event));
  });

  // Typing directly into either date field is a first-class selection path, not just a no-JS
  // fallback: it must update \`selected\` (so cell highlighting/aria-pressed/the live-region title
  // agree with what's typed) and must never leave a stale hidden extra-date field from an earlier
  // scattered pointer selection lying around to combine with the freshly typed toDate.
  const applyTypedRange = () => {
    form.querySelectorAll('input[data-bookkit-extra-date]').forEach((input) => input.remove());
    const date = dateInput.value;
    if (!date) { selected = []; anchor = null; renderCells(); return; }
    const toValue = toInput ? toInput.value : '';
    selected = toValue && toValue >= date
      ? [...cells.keys()].filter((key) => key >= date && key <= toValue)
      : [date];
    anchor = date;
    renderCells();
  };
  dateInput.addEventListener('change', applyTypedRange);
  if (toInput) toInput.addEventListener('change', applyTypedRange);
})();
`;
