// Progressive enhancement for the admin dashboard: in-place tab switching, one booking row open
// at a time, a deferred incident resolve note, a month pager, and multi-day calendar selection.
// Every one of these is an upgrade over markup that already works without it. IIFE so nothing
// leaks into the concatenated bundle.

export const adminEnhancerJs = `(() => {
  // --- tabs: the server already rendered every panel, with all but the current one hidden ---
  const tabStrip = document.querySelector('nav.bk-tabs');
  const panelBox = document.querySelector('.bk-panels');
  if (tabStrip && panelBox) {
    const panelIds = { upcoming: 'bk-upcoming', availability: 'bk-availability', attention: 'bk-attention' };
    tabStrip.addEventListener('click', (event) => {
      const link = event.target.closest('a[data-reserva-admin-tab]');
      if (!link) return;
      const wanted = panelIds[link.dataset.reservaAdminTab];
      if (!wanted || !document.getElementById(wanted)) return;
      event.preventDefault();
      for (const tab of tabStrip.querySelectorAll('a[data-reserva-admin-tab]')) {
        if (tab === link) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
      }
      for (const panel of panelBox.children) panel.hidden = panel.id !== wanted;
      history.replaceState(null, '', link.href);
    });
    // The header's attention link is a shortcut to the same panel, so it switches in place too.
    const attentionLink = document.querySelector('.bk-admin-attention');
    if (attentionLink) attentionLink.addEventListener('click', (event) => {
      const target = tabStrip.querySelector('a[data-reserva-admin-tab="attention"]');
      if (!target) return;
      event.preventDefault();
      target.click();
      const panel = document.getElementById('bk-attention');
      if (panel) panel.scrollIntoView({ block: 'start' });
    });
  }

  // --- booking rows: keeping one open stops the list collapsing back into a wall of detail ---
  const bookingList = document.getElementById('bk-upcoming');
  if (bookingList) {
    bookingList.addEventListener('toggle', (event) => {
      const row = event.target;
      if (!row.matches || !row.matches('.bk-booking[open]')) return;
      for (const other of bookingList.querySelectorAll('.bk-booking[open]')) {
        if (other !== row) other.open = false;
      }
    }, true);
  }

  // --- incident resolve note: asking "what did you do?" before Resolve is even pressed puts an
  // empty textarea on every open incident at once, so the first press reveals it instead ---
  for (const noteField of document.querySelectorAll('[data-reserva-resolve-note]')) {
    const form = noteField.closest('form');
    const submit = form && form.querySelector('button[value="incident-resolve"]');
    if (!submit) continue;
    noteField.hidden = true;
    submit.addEventListener('click', (event) => {
      if (!noteField.hidden) return;
      event.preventDefault();
      noteField.hidden = false;
      const textarea = noteField.querySelector('textarea');
      if (textarea) textarea.focus();
    });
  }

  const form = document.getElementById('bk-override');
  const monthsBox = document.querySelector('.bk-months');
  if (!form || !monthsBox) return;
  const dateInput = form.querySelector('input[name="date"]');
  let toInput = form.querySelector('input[name="toDate"]');
  const capacityInput = form.querySelector('input[name="capacity"]');
  const reasonDetails = form.querySelector('details');
  const reasonInput = form.querySelector('input[name="reason"]');
  const closeButton = form.querySelector('button[value="close"]');
  const title = form.querySelector('[data-reserva-day-title]');
  const announce = form.querySelector('[data-reserva-day-announce]');
  const detail = form.querySelector('[data-reserva-day-detail]');
  const island = form.querySelector('[data-reserva-i18n]');
  if (!dateInput || !capacityInput) return;
  // The visible To date is the no-JS range path, which multi-select replaces. A contiguous
  // selection still submits through toDate, so the field is swapped for a hidden input rather than
  // removed — and swapped rather than [hidden], which the day form's field layout rule outranks.
  const toField = form.querySelector('[data-reserva-to-date]');
  if (toField && toInput) {
    const hiddenTo = document.createElement('input');
    hiddenTo.type = 'hidden';
    hiddenTo.name = 'toDate';
    toField.replaceWith(hiddenTo);
    toInput = hiddenTo;
  }
  let i18n = {};
  try { i18n = JSON.parse(island ? island.textContent : '{}'); } catch {}
  const dayData = i18n.days || {};
  const dayLoads = i18n.loads || {};
  const closeLabel = closeButton ? closeButton.textContent : '';

  // --- month pager: one month visible at a time, prev/next buttons ---
  const monthEls = [...monthsBox.querySelectorAll('.bk-month')];
  // Set when the pager exists, so arrow-key navigation can turn the page it walks off.
  let showMonth = null;
  let syncTabStop = () => {};
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
    prev.addEventListener('click', () => { show(active - 1); syncTabStop(); });
    next.addEventListener('click', () => { show(active + 1); syncTabStop(); });
    show(active);
    showMonth = show;
  }

  // A visible hint before the calendar: Shift/Ctrl/Cmd-click and the Space toggle only exist once
  // this script is running, so no-JS markup never mentions them.
  if (i18n.selectHint) {
    const hint = document.createElement('p');
    hint.className = 'bk-hint bk-selection-hint';
    hint.setAttribute('data-reserva-select-hint', '');
    hint.textContent = i18n.selectHint;
    const firstMonth = monthsBox.querySelector('.bk-month');
    monthsBox.insertBefore(hint, firstMonth);
  }

  // --- day selection + form prefill + day panel ---
  const cells = new Map();
  const dayHrefs = new Map();
  monthsBox.querySelectorAll('.bk-day[data-date]').forEach((cell) => {
    cells.set(cell.dataset.date, cell);
    dayHrefs.set(cell.dataset.date, cell.getAttribute('href'));
    // Removing href (not just intercepting click) is required: a browser opens ctrl/cmd-click on
    // an <a href> as a new tab before any JS sees the click, so preventDefault() can't stop it.
    // The roving tabindex and the keydown listener below restore keyboard reach and activation.
    cell.removeAttribute('href');
    cell.tabIndex = -1;
    cell.setAttribute('role', 'button');
    // Starts from the server-rendered selected class, which already reflects initial selection.
    cell.setAttribute('aria-pressed', String(cell.classList.contains('bk-day--selected')));
  });
  let selected = dateInput.value && cells.has(dateInput.value) ? [dateInput.value] : [];
  let anchor = selected[0] || null;

  // Roving tabindex: the calendar is one Tab stop, and the arrow keys move within it, instead of
  // every day of every month sitting in the Tab order.
  const setTabStop = (target) => {
    cells.forEach((cell) => { cell.tabIndex = cell === target ? 0 : -1; });
  };
  syncTabStop = () => {
    const current = [...cells.values()].find((cell) => cell.tabIndex === 0);
    if (current && !current.closest('[hidden]')) return;
    const visible = [...cells.values()].filter((cell) => !cell.closest('[hidden]'));
    const target = visible.find((cell) => selected.includes(cell.dataset.date)) || visible[0];
    if (target) setTabStop(target);
  };
  syncTabStop();

  const renderDetail = (date) => {
    if (!detail) return;
    detail.textContent = '';
    if (!date) return;
    // The load line comes first, matching the server render, so the units figure survives a
    // client-side selection even though the cell itself only shows a dot.
    if (dayLoads[date]) {
      const load = document.createElement('p');
      load.className = 'bk-hint';
      load.textContent = dayLoads[date];
      detail.appendChild(load);
    }
    // The island stops at a row cap; a day past it links to its server-rendered panel rather
    // than claiming it has no bookings.
    if (i18n.detailBefore && date >= i18n.detailBefore) {
      const more = document.createElement('p');
      more.className = 'bk-hint';
      const link = document.createElement('a');
      link.href = dayHrefs.get(date) || '';
      link.textContent = i18n.dayOpen || '';
      more.appendChild(link);
      detail.appendChild(more);
      return;
    }
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
      const quantity = document.createElement('span');
      quantity.className = 'bk-sub';
      quantity.textContent = row.p;
      const status = document.createElement('span');
      status.className = 'bk-badge' + (row.sc ? ' bk-badge--' + row.sc : '');
      status.textContent = row.s;
      // row.u is present only when the server found a presentable operator token — otherwise
      // render plain text, never a link that would 403 the instant it's clicked.
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
      item.append(time, name, quantity, status, manage);
      list.appendChild(item);
    }
    detail.appendChild(list);
  };

  // Reflects \`selected\` onto the calendar cells and day panel. Shared by every path that changes
  // \`selected\` (pointer, Space, typed dates) so all three stay in sync. Returns the sorted
  // selection for callers that also rewrite the form fields.
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
      if (title) title.textContent = (i18n.selectedDays || '{n} days selected').replace('{n}', sorted.length);
      if (closeButton && i18n.closeMany) closeButton.textContent = i18n.closeMany.replace('{n}', sorted.length);
      renderDetail(null);
    } else {
      if (title) title.textContent = i18n.title || '';
      if (closeButton) closeButton.textContent = i18n.close || closeLabel;
      renderDetail(null);
    }
    // The live region (server markup) repeats the new title, so a screen reader hears the
    // selection change without focus leaving the calendar.
    if (announce && title) announce.textContent = title.textContent;
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
  // date+toDate; a scattered set travels as repeated hidden date fields with toDate blanked so it
  // never implies a range covering the gaps. Always clears the other shape's fields first.
  const applySelection = () => {
    const sorted = renderCells();
    form.querySelectorAll('input[data-reserva-extra-date]').forEach((input) => input.remove());
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
        hidden.setAttribute('data-reserva-extra-date', '');
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
    setTabStop(cell);
    selectDate(cell.dataset.date, modeFromEvent(event));
  });

  const arrowSteps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
  const shiftDate = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

  // href is gone (see above), so Enter/Space aren't wired by the browser anymore — both are
  // handled here, sharing the same modifier-based mode as a click. The arrows move focus a day or
  // a week, turning the month page when they walk off it.
  monthsBox.addEventListener('keydown', (event) => {
    const cell = event.target.closest('.bk-day[data-date]');
    if (!cell) return;
    const step = arrowSteps[event.key];
    if (step !== undefined) {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      const target = cells.get(shiftDate(cell.dataset.date, step));
      if (!target) return;
      const month = target.closest('.bk-month');
      if (showMonth && month && month.hidden) showMonth(monthEls.indexOf(month));
      setTabStop(target);
      target.focus();
      return;
    }
    if (event.key !== ' ' && event.key !== 'Spacebar' && event.key !== 'Enter') return;
    event.preventDefault();
    selectDate(cell.dataset.date, modeFromEvent(event));
  });

  // Typing a date is a first-class selection path: it must update \`selected\` (so
  // highlighting/aria-pressed/the title stay in sync) and must clear both range shapes an earlier
  // selection left behind — the toDate is hidden now, so a stale one would silently widen (or
  // invert) what gets submitted.
  const applyTypedDate = () => {
    form.querySelectorAll('input[data-reserva-extra-date]').forEach((input) => input.remove());
    if (toInput) toInput.value = '';
    const date = dateInput.value;
    selected = date ? [date] : [];
    anchor = date || null;
    renderCells();
  };
  dateInput.addEventListener('change', applyTypedDate);
})();
`;
