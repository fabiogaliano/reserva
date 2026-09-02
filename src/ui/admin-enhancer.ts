// Progressive enhancement for the admin section nav and calendar: adds current-section tracking,
// a month pager, and multi-day selection. IIFE so nothing leaks into the concatenated bundle.

export const adminEnhancerJs = `(() => {
  const sectionNav = document.querySelector('[data-reserva-section-nav]');
  if (sectionNav) {
    const links = [...sectionNav.querySelectorAll('[data-reserva-section-link]')];
    const entries = links.map((link) => {
      const href = link.getAttribute('href') || '';
      return { link, section: href.startsWith('#') ? document.getElementById(href.slice(1)) : null };
    }).filter((entry) => entry.section);
    const setCurrent = (current) => {
      for (const entry of entries) {
        if (entry === current) entry.link.setAttribute('aria-current', 'location');
        else entry.link.removeAttribute('aria-current');
      }
    };
    let frame = 0;
    const updateCurrent = () => {
      frame = 0;
      if (!entries.length) return;
      const marker = Math.min(220, window.innerHeight * 0.3);
      let current = entries[0];
      for (const entry of entries) {
        if (entry.section.getBoundingClientRect().top <= marker) current = entry;
      }
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) current = entries[entries.length - 1];
      setCurrent(current);
    };
    const queueUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(updateCurrent);
    };
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const entry of entries) {
      entry.link.addEventListener('click', (event) => {
        event.preventDefault();
        history.pushState(null, '', entry.link.hash);
        setCurrent(entry);
        entry.section.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      });
    }
    window.addEventListener('scroll', queueUpdate, { passive: true });
    window.addEventListener('resize', queueUpdate);
    window.addEventListener('hashchange', queueUpdate);
    updateCurrent();
  }

  const form = document.getElementById('bk-override');
  const monthsBox = document.querySelector('.bk-months');
  if (!form || !monthsBox) return;
  const dateInput = form.querySelector('input[name="date"]');
  const toInput = form.querySelector('input[name="toDate"]');
  const capacityInput = form.querySelector('input[name="capacity"]');
  const reasonDetails = form.querySelector('details');
  const reasonInput = form.querySelector('input[name="reason"]');
  const closeButton = form.querySelector('button[value="close"]');
  const title = form.querySelector('[data-reserva-day-title]');
  const detail = form.querySelector('[data-reserva-day-detail]');
  const island = form.querySelector('[data-reserva-i18n]');
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
    hint.setAttribute('data-reserva-select-hint', '');
    hint.textContent = i18n.selectHint;
    const firstMonth = monthsBox.querySelector('.bk-month');
    monthsBox.insertBefore(hint, firstMonth);
  }

  // --- day selection + form prefill + day panel ---
  const cells = new Map();
  monthsBox.querySelectorAll('.bk-day[data-date]').forEach((cell) => {
    cells.set(cell.dataset.date, cell);
    // Removing href (not just intercepting click) is required: a browser opens ctrl/cmd-click on
    // an <a href> as a new tab before any JS sees the click, so preventDefault() can't stop it.
    // tabIndex and the keydown listener below restore the lost tab-stop and Enter-activation.
    cell.removeAttribute('href');
    cell.tabIndex = 0;
    cell.setAttribute('role', 'button');
    // Starts from the server-rendered selected class, which already reflects initial selection.
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
    selectDate(cell.dataset.date, modeFromEvent(event));
  });

  // href is gone (see above), so Enter/Space aren't wired by the browser anymore — both are
  // handled here, sharing the same modifier-based mode as a click.
  monthsBox.addEventListener('keydown', (event) => {
    if (event.key !== ' ' && event.key !== 'Spacebar' && event.key !== 'Enter') return;
    const cell = event.target.closest('.bk-day[data-date]');
    if (!cell) return;
    event.preventDefault();
    selectDate(cell.dataset.date, modeFromEvent(event));
  });

  // Typing into either date field is a first-class selection path: it must update \`selected\` (so
  // highlighting/aria-pressed/the title stay in sync) and must clear stale hidden extra-date
  // fields left by an earlier scattered pointer selection.
  const applyTypedRange = () => {
    form.querySelectorAll('input[data-reserva-extra-date]').forEach((input) => input.remove());
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
