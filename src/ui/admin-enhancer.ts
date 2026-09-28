// Progressive enhancement for the admin dashboard: in-place tab switching, one booking row open
// at a time, the "/" search shortcut, copy buttons, a deferred incident resolve note, and the
// availability calendar's pager, multi-day selection and day card. Every one of these is an
// upgrade over markup that already works without it. IIFE so nothing leaks into the concatenated
// bundle.

export const adminEnhancerJs = `(() => {
  // --- tabs: the server already rendered every panel, with all but the current one hidden ---
  const tabStrip = document.querySelector('nav.bk-tabs');
  const panelBox = document.querySelector('.bk-panels');
  if (tabStrip && panelBox) {
    const panelIds = { upcoming: 'bk-upcoming', availability: 'bk-availability', attention: 'bk-attention' };
    const switchTo = (link) => {
      const tab = link.dataset.reservaAdminTab;
      const wanted = panelIds[tab];
      if (!wanted || !document.getElementById(wanted)) return false;
      for (const other of tabStrip.querySelectorAll('a[data-reserva-admin-tab]')) {
        if (other === link) other.setAttribute('aria-current', 'page');
        else other.removeAttribute('aria-current');
      }
      for (const panel of panelBox.children) panel.hidden = panel.id !== wanted;
      // The totals strip belongs to the bookings list, and the attention banner is redundant on
      // the tab it points at.
      for (const el of document.querySelectorAll('[data-reserva-tab-only]')) el.hidden = el.dataset.reservaTabOnly !== tab;
      for (const el of document.querySelectorAll('[data-reserva-tab-except]')) el.hidden = el.dataset.reservaTabExcept === tab;
      history.replaceState(null, '', link.href);
      return true;
    };
    tabStrip.addEventListener('click', (event) => {
      const link = event.target.closest('a[data-reserva-admin-tab]');
      if (link && switchTo(link)) event.preventDefault();
    });
    // The banner's link is a shortcut to the same panel, so it switches in place too.
    const attentionLink = document.querySelector('[data-reserva-attention-link]');
    if (attentionLink) attentionLink.addEventListener('click', (event) => {
      const target = tabStrip.querySelector('a[data-reserva-admin-tab="attention"]');
      if (!target || !switchTo(target)) return;
      event.preventDefault();
      tabStrip.scrollIntoView({ block: 'start' });
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

  // --- "/" jumps to the search box, the shortcut every list-heavy tool shares ---
  const search = document.querySelector('[data-reserva-search]');
  if (search) {
    const hint = search.parentElement && search.parentElement.querySelector('.bk-kbd');
    if (hint) hint.hidden = false;
    document.addEventListener('keydown', (event) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target.closest('input, textarea, select, [contenteditable]')) return;
      if (search.closest('[hidden]')) return;
      event.preventDefault();
      search.focus();
      search.select();
    });
  }

  // --- copy buttons: rendered hidden, so they only appear where the clipboard is reachable ---
  if (navigator.clipboard && window.isSecureContext) {
    for (const button of document.querySelectorAll('[data-reserva-copy]')) {
      button.hidden = false;
      const label = button.getAttribute('aria-label') || '';
      button.addEventListener('click', (event) => {
        // Inside a row's disclosure, but never a reason to toggle it.
        event.preventDefault();
        navigator.clipboard.writeText(button.dataset.reservaCopy || '').then(() => {
          button.classList.add('bk-copy--done');
          button.setAttribute('aria-label', button.dataset.copied || label);
          button.title = button.dataset.copied || label;
          setTimeout(() => {
            button.classList.remove('bk-copy--done');
            button.setAttribute('aria-label', label);
            button.title = label;
          }, 1500);
        }, () => {});
      });
    }
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
  const reasonInput = form.querySelector('input[name="reason"]');
  const closeButton = form.querySelector('[data-reserva-day-actions] button[value="close"]');
  const resetButton = form.querySelector('[data-reserva-day-reset]');
  const title = form.querySelector('[data-reserva-day-title]');
  const rel = form.querySelector('[data-reserva-day-rel]');
  const badge = form.querySelector('[data-reserva-day-badge]');
  const announce = form.querySelector('[data-reserva-day-announce]');
  const detail = form.querySelector('[data-reserva-day-detail]');
  const editRow = form.querySelector('[data-reserva-day-edit]');
  const actions = form.querySelector('[data-reserva-day-actions]');
  const reopen = form.querySelector('[data-reserva-day-reopen]');
  const reopenHint = form.querySelector('[data-reserva-day-reopen-hint]');
  const island = form.querySelector('[data-reserva-i18n]');
  if (!dateInput || !capacityInput) return;
  // The visible To date is the no-JS range path, which multi-select replaces. A contiguous
  // selection still submits through toDate, so the field is swapped for a hidden input rather than
  // removed — and swapped rather than [hidden], which the form's field layout rule outranks.
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
  const dayMeta = i18n.meta || {};
  const fill = (template, values) => String(template || '').replace(/\\{(\\w+)\\}/g, (match, key) => (key in values ? String(values[key]) : match));
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // --- capacity stepper: the buttons are server-rendered hidden, since only this can drive them ---
  for (const stepper of form.querySelectorAll('.bk-stepper')) {
    const input = stepper.querySelector('input');
    for (const button of stepper.querySelectorAll('button[data-step]')) {
      button.hidden = false;
      button.addEventListener('click', () => {
        input.value = String(Math.max(0, (Number(input.value) || 0) + Number(button.dataset.step)));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
  }

  // --- month pager: two months at a time, so a page never ends at the edge of the week that
  // matters, with a way back to today ---
  const monthEls = [...monthsBox.querySelectorAll('.bk-month')];
  // Set when the pager exists, so arrow-key navigation can turn the page it walks off.
  let showMonth = null;
  let syncTabStop = () => {};
  const monthName = (key, withYear) => new Intl.DateTimeFormat(i18n.locale || undefined, { month: 'long', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' })
    .format(new Date(key + '-01T00:00:00Z'));
  for (const month of monthEls) {
    if (month.tagName !== 'DETAILS') continue;
    // A collapsed later month becomes a plain page of the pager: open, with a heading like the
    // first two months instead of its disclosure summary.
    month.open = true;
    const summary = month.querySelector('summary');
    if (summary) summary.hidden = true;
    const heading = el('h3', '', month.dataset.label || '');
    const body = month.querySelector('summary + div');
    if (body) body.prepend(heading);
  }
  const pager = el('div', 'bk-pager');
  const pagerTitle = el('h3');
  pagerTitle.setAttribute('aria-live', 'polite');
  const mkButton = (label, text, className) => {
    const button = el('button', 'bk-btn bk-btn--secondary bk-btn--sm' + (className ? ' ' + className : ''), text);
    button.type = 'button';
    if (label !== text) button.setAttribute('aria-label', label || '');
    return button;
  };
  const todayButton = mkButton(i18n.todayLabel, i18n.todayLabel, 'bk-pager-today');
  const prev = mkButton(i18n.prevMonth, '\\u2039');
  const next = mkButton(i18n.nextMonth, '\\u203a');
  pager.append(pagerTitle, todayButton, prev, next);
  monthsBox.insertBefore(pager, monthsBox.firstChild);
  let active = 0;
  const show = (index) => {
    active = Math.min(Math.max(index, 0), Math.max(0, monthEls.length - 2));
    monthEls.forEach((month, idx) => { month.hidden = idx !== active && idx !== active + 1; });
    const first = monthEls[active] && monthEls[active].dataset.month;
    const second = monthEls[active + 1] && monthEls[active + 1].dataset.month;
    pagerTitle.textContent = !first ? ''
      : !second ? monthName(first, true)
      : first.slice(0, 4) === second.slice(0, 4) ? monthName(first, false) + ' \\u2013 ' + monthName(second, true)
      : monthName(first, true) + ' \\u2013 ' + monthName(second, true);
    prev.disabled = active === 0;
    next.disabled = active >= monthEls.length - 2;
  };
  // Keeps a month on screen without jumping the page when it already is.
  const reveal = (monthIndex) => {
    if (monthIndex < active) show(monthIndex);
    else if (monthIndex > active + 1) show(monthIndex - 1);
  };
  prev.addEventListener('click', () => { show(active - 1); syncTabStop(); });
  next.addEventListener('click', () => { show(active + 1); syncTabStop(); });
  show(Math.max(0, monthEls.findIndex((month) => month.querySelector('[aria-current="date"]'))));
  showMonth = reveal;

  // One line under the legend: Shift/Ctrl/Cmd-click, dragging and the Space toggle only exist once
  // this script is running, so no-JS markup never mentions them. A touch screen has no modifier
  // keys, so it gets the drag instruction alone.
  const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const hintText = touch ? i18n.selectHintTouch : i18n.selectHint;
  if (hintText) {
    const hint = el('p', 'bk-hint bk-selection-hint', hintText);
    hint.setAttribute('data-reserva-select-hint', '');
    const legend = monthsBox.parentElement && monthsBox.parentElement.querySelector('.bk-legend');
    if (legend) legend.after(hint);
    else monthsBox.after(hint);
  }

  // --- day selection + form prefill + day card ---
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

  const longDate = (date) => new Intl.DateTimeFormat(i18n.locale || undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(date + 'T00:00:00Z'));
  const relativeDay = (date) => {
    const offset = Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse((i18n.today || date) + 'T00:00:00Z')) / 86400000);
    if (Math.abs(offset) > 1) return '';
    const label = new Intl.RelativeTimeFormat(i18n.locale || undefined, { numeric: 'auto' }).format(offset, 'day');
    return label.charAt(0).toLocaleUpperCase(i18n.locale || undefined) + label.slice(1);
  };
  // Same tenths as the server's meterFill, so a selected day's bar matches its cell.
  const meterFill = (peak, capacity) => (capacity <= 0 || peak <= 0 ? 0 : Math.min(10, Math.max(1, Math.round((peak / capacity) * 10))) * 10);
  const bookingCount = (n) => fill(n === 1 ? i18n.bookingOne : i18n.bookingMany, { n });
  const guestsIcon = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';

  const renderDetail = (date, capacity, meta) => {
    if (!detail) return;
    detail.textContent = '';
    if (!date) return;
    if (capacity > 0) {
      const line = el('div', 'bk-loadline');
      const top = el('div', 'bk-loadline-top');
      top.append(el('span', '', fill(i18n.peak, { peak: meta[2], capacity })), el('span', '', bookingCount(meta[3])));
      const meter = el('span', 'bk-meter bk-meter--bar' + (meta[2] >= capacity ? ' bk-meter--full' : ''));
      meter.dataset.fill = String(meterFill(meta[2], capacity));
      meter.setAttribute('aria-hidden', 'true');
      meter.append(el('i'));
      line.append(top, meter);
      detail.append(line);
    }
    // The island stops at a row cap; a day past it links to its server-rendered panel rather
    // than claiming it has no bookings.
    if (i18n.detailBefore && date >= i18n.detailBefore) {
      const more = el('p', 'bk-hint');
      const link = el('a', '', i18n.dayOpen || '');
      link.href = dayHrefs.get(date) || '';
      more.append(link);
      detail.append(more);
      return;
    }
    const rows = dayData[date] || [];
    if (!rows.length) {
      detail.append(el('p', 'bk-hint', i18n.noBookings || ''));
      return;
    }
    const list = el('ul', 'bk-daylist');
    for (const row of rows) {
      const item = el('li');
      const who = el('span');
      who.append(el('strong', '', row.c), el('span', 'bk-sub', row.v));
      const guests = el('span', 'bk-booking-guests');
      guests.title = row.gl;
      guests.innerHTML = guestsIcon;
      const figure = el('span', '', row.g);
      figure.setAttribute('aria-hidden', 'true');
      guests.append(figure, el('span', 'bk-sr-only', row.gl));
      const end = el('span', 'bk-daylist-end');
      // Field tags and money badges, in the order the server rendered them ahead of the status.
      for (const tag of row.b || []) {
        const badge = el('span', 'bk-badge' + (tag.m ? ' bk-badge--' + tag.m : ''), tag.t);
        if (tag.h) badge.title = tag.h;
        end.append(badge);
      }
      if (row.s) end.append(el('span', 'bk-badge' + (row.sc ? ' bk-badge--' + row.sc : ''), row.s));
      // row.u is present only when the server found a presentable operator token — otherwise
      // render plain text, never a link that would 403 the instant it's clicked.
      if (row.u) {
        const manage = el('a', 'bk-link', i18n.manage || '');
        manage.href = row.u;
        end.append(manage);
      } else {
        end.append(el('span', 'bk-sub', i18n.manageUnavailable || ''));
      }
      item.append(el('time', '', row.t), who, guests, end);
      list.append(item);
    }
    detail.append(list);
  };

  // Reflects \`selected\` onto the calendar cells and the day card. Shared by every path that
  // changes \`selected\` (pointer, drag, keyboard) so they stay in sync. Returns the sorted
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
      const date = sorted[0];
      const meta = dayMeta[date] || [Number((cells.get(date) || {}).dataset?.capacity) || 0, 0, 0, 0, 0];
      const capacity = meta[0];
      const adjusted = meta[4] === 1;
      const reason = meta[5] || '';
      const reopenable = capacity === 0 && adjusted;
      if (title) title.textContent = longDate(date);
      if (rel) {
        rel.textContent = relativeDay(date);
        rel.hidden = !rel.textContent;
      }
      if (badge) {
        badge.hidden = false;
        badge.className = 'bk-badge bk-badge--' + (capacity === 0 ? 'danger' : adjusted ? 'warn' : 'ok');
        badge.textContent = capacity === 0
          ? (reason ? fill(i18n.closedReason, { reason }) : i18n.closedBadge || '')
          : adjusted ? fill(i18n.adjustedBadge, { n: capacity, d: meta[1] }) : fill(i18n.openBadge, { n: capacity });
      }
      renderDetail(date, capacity, meta);
      capacityInput.value = String(capacity);
      if (reasonInput) reasonInput.value = reason;
      if (editRow) editRow.hidden = reopenable;
      if (actions) actions.hidden = reopenable;
      if (reopen) reopen.hidden = !reopenable;
      if (reopenHint) reopenHint.textContent = fill(i18n.reopenHint, { n: meta[1] });
      if (resetButton) {
        resetButton.hidden = !adjusted;
        resetButton.textContent = fill(i18n.clearTo, { n: meta[1] });
      }
      if (closeButton) closeButton.textContent = i18n.close || '';
    } else if (sorted.length > 1) {
      if (title) title.textContent = fill(i18n.selectedDays, { n: sorted.length });
      if (rel) rel.hidden = true;
      if (badge) badge.hidden = true;
      renderDetail(null);
      if (reasonInput) reasonInput.value = '';
      if (editRow) editRow.hidden = false;
      if (actions) actions.hidden = false;
      if (reopen) reopen.hidden = true;
      if (resetButton) {
        resetButton.hidden = false;
        resetButton.textContent = fill(i18n.clearMany, { n: sorted.length });
      }
      if (closeButton) closeButton.textContent = fill(i18n.closeMany, { n: sorted.length });
    }
    // The live region (server markup) repeats the new title, so a screen reader hears the
    // selection change without focus leaving the calendar.
    if (announce && title) announce.textContent = title.textContent;
    return sorted;
  };

  const isContiguous = (sorted) => {
    for (let i = 1; i < sorted.length; i += 1) {
      const prevDay = Date.parse(sorted[i - 1] + 'T00:00:00Z');
      const cur = Date.parse(sorted[i] + 'T00:00:00Z');
      if (cur - prevDay !== 86400000) return false;
    }
    return true;
  };

  // Rewrites the form's submission shape from \`selected\`: a contiguous run travels as
  // date+toDate; a scattered set travels as repeated hidden date fields with toDate blanked so it
  // never implies a range covering the gaps. Always clears the other shape's fields first.
  const applySelection = () => {
    const sorted = renderCells();
    form.querySelectorAll('input[data-reserva-extra-date]').forEach((input) => input.remove());
    if (sorted.length === 0) return;
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
      // The card always describes at least one day, so the last one cannot be toggled off.
      if (selected.includes(date) && selected.length === 1) return;
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

  // Dragging across days selects the run between them — the one range gesture a touch screen has.
  // The selection starts on the first move, so a plain tap stays a click.
  let drag = null;
  let swallowClick = false;
  monthsBox.addEventListener('pointerdown', (event) => {
    const cell = event.target.closest('.bk-day[data-date]');
    if (!cell || event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey) return;
    drag = { start: cell.dataset.date, current: cell.dataset.date, moved: false };
  });
  monthsBox.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const cell = under && under.closest ? under.closest('.bk-day[data-date]') : null;
    if (!cell || cell.dataset.date === drag.current) return;
    drag.current = cell.dataset.date;
    drag.moved = true;
    anchor = drag.start;
    selectDate(drag.current, 'range');
    setTabStop(cell);
  });
  const endDrag = () => {
    if (drag && drag.moved) {
      swallowClick = true;
      // A drag that ends outside the grid fires no click, and the flag must not eat the next one.
      setTimeout(() => { swallowClick = false; });
    }
    drag = null;
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', () => { drag = null; });

  monthsBox.addEventListener('click', (event) => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    const cell = event.target.closest('.bk-day[data-date]');
    if (!cell) return;
    setTabStop(cell);
    selectDate(cell.dataset.date, modeFromEvent(event));
  });

  todayButton.addEventListener('click', () => {
    const cell = cells.get(i18n.today);
    if (!cell) return;
    const month = cell.closest('.bk-month');
    show(Math.max(0, monthEls.indexOf(month)));
    setTabStop(cell);
    selectDate(i18n.today, 'replace');
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
})();
`;
