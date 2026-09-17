// The whole visual system as one stylesheet string, served at assetsCss so pages can reference it
// as an external same-origin file (keeps CSP intact — no inline <style>). Every value routes
// through a --bk-* custom property so a client site can rebrand without touching reserva.
// The palettes themselves are not declared here: they are lifted from src/ui/tokens.css, the one
// place a --bk-* default may live, so this stylesheet and the components' CSS cannot drift.
import { darkTokens, lightTokens } from './generated/tokens.js';

export const themeCss = `
:root {
  /* Keeps native control chrome (select dropdowns, date pickers, scrollbars) in step with the
     token flip below — without it they stay light inside the dark theme. */
  color-scheme: light dark;${lightTokens}
}
/* Applies when the OS prefers dark and no theme is forced, or when the viewer picks dark via the
   bk_theme cookie (reflected onto <html data-theme> server-side for a flash-free first paint).
   :root[data-theme] outranks the media query, so a forced light theme wins under a dark OS. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {${darkTokens}
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;${darkTokens}
}
:root[data-theme="light"] { color-scheme: light; }

.bk-page {
  margin: 0;
  min-height: 100vh;
  background: var(--bk-bg);
  color: var(--bk-text);
  font-family: var(--bk-font);
  line-height: 1.5;
  -webkit-text-size-adjust: 100%;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.bk-skip {
  position: fixed;
  top: 0.75rem;
  left: 0.75rem;
  z-index: 100;
  padding: 0.65rem 0.85rem;
  border-radius: var(--bk-radius-sm);
  background: var(--bk-surface);
  color: var(--bk-text);
  font-weight: 600;
  box-shadow: var(--bk-focus), var(--bk-shadow);
  translate: 0 -200%;
}
.bk-skip:focus { translate: 0; }

/* Masthead: the near-black header band every page opens with, same in both color schemes. Cards
   below overlap its lower edge (bk-main--raised). */
.bk-masthead {
  background:
    radial-gradient(70rem 26rem at 88% -30%, color-mix(in srgb, #5e6ad2 30%, transparent), transparent 60%),
    linear-gradient(180deg, #111216, #0a0b0d);
  border-bottom: 1px solid rgb(255 255 255 / 0.08);
  color: var(--bk-masthead-text);
  padding: 2rem 1rem 4.25rem;
}
.bk-masthead-inner { max-width: 44rem; margin: 0 auto; }
.bk-masthead-inner--mid { max-width: 56rem; }
.bk-masthead-inner--wide { max-width: 72rem; }
.bk-masthead h1 {
  font-size: clamp(1.6rem, 1.25rem + 1.6vw, 2.1rem);
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.02em;
  margin: 0.45rem 0 0.35rem;
  color: var(--bk-masthead-text);
  text-wrap: balance;
}
.bk-masthead .bk-lead { color: var(--bk-masthead-muted); margin-bottom: 0; }
.bk-masthead .bk-brand { color: var(--bk-masthead-brand); }
.bk-masthead .bk-backlink { margin: 0 0 0.75rem; }
.bk-masthead .bk-backlink a { color: var(--bk-masthead-muted); }
.bk-masthead .bk-backlink a:hover { color: var(--bk-masthead-text); }
/* Badges on the dark band become neutral glass; the status color survives in the dot. */
.bk-masthead .bk-badge { background: rgb(255 255 255 / 0.09); color: var(--bk-masthead-text); border: 1px solid rgb(255 255 255 / 0.14); }
.bk-masthead .bk-badge--ok::before { background: #6fd394; }
.bk-masthead .bk-badge--warn::before { background: #eec26f; }
.bk-masthead .bk-badge--danger::before { background: #f2a099; }
.bk-masthead .bk-badge--accent::before { background: #a9b1ef; }
.bk-masthead .bk-btn--secondary {
  background: rgb(255 255 255 / 0.07);
  color: var(--bk-masthead-text);
  border-color: rgb(255 255 255 / 0.16);
}
.bk-masthead .bk-pagehead .bk-lead { margin-bottom: 0; }

/* Per-viewer toggle (System → Light → Dark), server-rendered hidden; the enhancer reveals it so
   no-JS viewers get the OS default instead of a dead control. Uses the masthead's glass button
   treatment on both the dark masthead and dark sidebar. */
.bk-theme-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.35rem 0.65rem;
  border-radius: var(--bk-radius-sm);
  border: 1px solid rgb(255 255 255 / 0.16);
  background: rgb(255 255 255 / 0.07);
  color: var(--bk-masthead-text);
  font: inherit;
  font-size: 0.8rem;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  transition: background-color 100ms ease;
}
@media (hover: hover) and (pointer: fine) {
  .bk-theme-toggle:hover { background: rgb(255 255 255 / 0.13); }
}
.bk-theme-toggle:focus-visible { outline: none; box-shadow: var(--bk-focus); }
.bk-theme-toggle svg { flex: none; opacity: 0.85; }
/* In-flow as the masthead's first row, right-aligned, so title text below can't underlap the
   control on a narrow screen. */
.bk-masthead .bk-theme-toggle { display: flex; width: fit-content; margin: 0 0 0.9rem auto; }
.bk-sidebar .bk-theme-toggle { grid-column: 2; grid-row: 1; min-height: 2.75rem; margin-left: auto; }
@media (min-width: 880px) {
  .bk-sidebar .bk-theme-toggle { grid-column: auto; grid-row: auto; width: 100%; margin: auto 0 0; justify-content: center; }
}
/* Scoped higher than the display rules above so the server-rendered button stays hidden until the
   enhancer reveals it, no matter the source order of the context rules. */
.bk-masthead .bk-theme-toggle[hidden],
.bk-sidebar .bk-theme-toggle[hidden] { display: none; }

.bk-main { max-width: 44rem; margin: 0 auto; padding: 1.75rem 1rem 4rem; }
.bk-main--mid { max-width: 56rem; }
.bk-main--wide { max-width: 72rem; }
.bk-main--raised { position: relative; margin-top: -2.75rem; padding-top: 0; }
.bk-main--shell { max-width: none; margin: 0; padding: 0; }

/* Operators revisit this surface throughout the day, so navigation stays stable while the work
   area favors scan speed over decorative chrome. */
.bk-shell { display: grid; min-height: 100vh; grid-template-rows: auto 1fr; }
.bk-sidebar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.65rem 0.75rem 0.55rem;
  background: #101114;
  border-bottom: 1px solid rgb(255 255 255 / 0.08);
  box-sizing: border-box;
  min-width: 0;
}
.bk-sidebar-brand {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-width: 0;
  margin: 0;
  padding: 0 0.35rem;
  font-size: 0.9rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: #ededef;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bk-sidebar-brand::before {
  content: '';
  flex: none;
  width: 0.62rem;
  height: 0.62rem;
  border-radius: 3px;
  background: #6975df;
  box-shadow: 0 0 14px color-mix(in srgb, #6975df 70%, transparent);
}
.bk-sidebar-links {
  grid-column: 1 / -1;
  display: flex;
  gap: 0.25rem;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.bk-sidebar-links::-webkit-scrollbar { display: none; }
.bk-sidebar a {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-height: 2.75rem;
  box-sizing: border-box;
  padding: 0.55rem 0.7rem;
  border-radius: 8px;
  color: #aeb1b8;
  text-decoration: none;
  font-size: 0.88rem;
  font-weight: 500;
  white-space: nowrap;
  transition: background-color 120ms ease, color 120ms ease;
}
@media (hover: hover) and (pointer: fine) {
  .bk-sidebar a:hover { background: rgb(255 255 255 / 0.06); color: #ededef; }
}
.bk-sidebar a.bk-active { background: rgb(255 255 255 / 0.1); color: #ffffff; }
.bk-sidebar a:focus-visible { outline: none; box-shadow: var(--bk-focus); }
.bk-sidebar svg { flex: none; opacity: 0.82; }
.bk-sidebar-label { display: none; }
@media (max-width: 879px) {
  .bk-sidebar-links svg { display: none; }
  .bk-sidebar-links a { padding-inline: 0.6rem; }
}
.bk-shell-main {
  width: 100%;
  max-width: 76rem;
  min-width: 0;
  margin: 0 auto;
  padding: 1.5rem 1rem 4rem;
  box-sizing: border-box;
}
@media (min-width: 880px) {
  .bk-shell { grid-template-columns: 15.5rem minmax(0, 1fr); grid-template-rows: none; }
  .bk-sidebar {
    height: 100vh;
    align-self: start;
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr auto;
    align-items: stretch;
    gap: 0;
    padding: 1.25rem 0.9rem;
    border-right: 1px solid rgb(255 255 255 / 0.08);
    border-bottom: 0;
  }
  .bk-sidebar-brand { margin: 0 0.35rem 1.25rem; padding: 0; }
  .bk-sidebar-links { grid-column: auto; flex-direction: column; overflow: visible; }
  .bk-shell-main { padding: 2rem clamp(1.5rem, 3vw, 3rem) 5rem; }
  .bk-sidebar-label { display: block; margin: 1.1rem 0.6rem 0.35rem; font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.09em; color: #6e7076; }
}
.bk-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin: 0 0 1.25rem; }
.bk-toolbar h1 { margin: 0; font-size: 1.25rem; font-weight: 600; letter-spacing: -0.01em; }
.bk-toolbar .bk-lead { margin: 0.15rem 0 0; font-size: 0.9rem; }
/* Bookings dashboard. The operator opens this many times a day, so the page states what it is and
   then gets out of the way: a title row, a tab strip, and one panel on screen at a time. */
.bk-admin-header { display: flex; align-items: center; gap: 0.75rem 1rem; flex-wrap: wrap; margin: 0 0 1.25rem; }
.bk-admin-header h1 { margin: 0; font-size: 1.5rem; font-weight: 600; line-height: 1.2; letter-spacing: -0.025em; }
.bk-admin-attention {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  color: var(--bk-danger);
  font-size: 0.9rem;
  font-weight: 500;
  text-decoration: none;
}
.bk-admin-attention:hover { text-decoration: underline; }
.bk-admin-attention:focus-visible { outline: none; box-shadow: var(--bk-focus); border-radius: 4px; }
/* Panels are all server-rendered and all but one carry [hidden], so the tab strip works as plain
   links before the enhancer upgrades it to an in-page toggle. */
.bk-panels > [hidden] { display: none; }
/* The list is a reading measure, not a spreadsheet: past roughly 60rem the chevron drifts so far
   from the name that a row stops reading as one thing. The calendar earns the extra width. */
.bk-panel { min-width: 0; max-width: 62rem; }
#bk-availability { max-width: none; }
.bk-tab-count {
  margin-left: 0.4rem;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: var(--bk-danger-soft);
  color: var(--bk-danger);
  font-size: 0.75rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

/* One search control, no field label: the placeholder already says what it searches. */
.bk-searchbar { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; margin: 0 0 1.5rem; }
.bk-searchbar .bk-input, .bk-searchbar .bk-select { width: auto; min-height: 2.6rem; }
.bk-searchbar .bk-input[type=search] { flex: 1 1 16rem; max-width: 24rem; }
.bk-searchbar .bk-select { flex: 0 0 auto; }
.bk-searchbar .bk-btn { min-height: 2.6rem; }
.bk-searchbar .bk-filter-clear { min-height: 2.6rem; }

/* Day-grouped booking list. Every row is a native <details>: the summary holds what an operator
   scans by and the panel holds the rest, so the list never grows a column for a detail that only
   matters on one booking in twenty. Works with scripting off; the enhancer only adds
   one-open-at-a-time. */
.bk-daygroup { margin: 0 0 1.75rem; }
.bk-daygroup > h3 {
  margin: 0 0 0.35rem;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--bk-text-muted);
}
.bk-booking { border-bottom: 1px solid color-mix(in srgb, var(--bk-border) 55%, transparent); }
.bk-booking > summary {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) auto 1rem;
  align-items: center;
  gap: 0.2rem 1rem;
  min-height: 3.25rem;
  padding: 0.5rem 0.6rem;
  border-radius: var(--bk-radius-sm);
  list-style: none;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.bk-booking > summary::-webkit-details-marker { display: none; }
@media (hover: hover) and (pointer: fine) {
  .bk-booking > summary:hover { background: color-mix(in srgb, var(--bk-surface-2) 55%, transparent); }
}
.bk-booking > summary:focus-visible { outline: none; box-shadow: var(--bk-focus); }
.bk-booking[open] > summary { background: color-mix(in srgb, var(--bk-surface-2) 45%, transparent); }
@media (prefers-reduced-motion: reduce) { .bk-booking > summary { transition: none; } }
.bk-booking-time { min-width: 3.25rem; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bk-booking-who { font-weight: 500; }
.bk-booking-sub { display: block; margin-top: 0.15rem; font-size: 0.85rem; color: var(--bk-text-muted); }
/* Only a status that is not the happy path earns text; a list of confirmed bookings stays quiet. */
.bk-booking-status { font-size: 0.85rem; white-space: nowrap; color: var(--bk-text-muted); }
.bk-booking-status--warn { color: var(--bk-warning); }
.bk-booking-status--danger { color: var(--bk-danger); }
.bk-booking-chevron { justify-self: end; color: var(--bk-text-muted); transition: rotate 160ms var(--bk-ease); }
.bk-booking[open] > summary .bk-booking-chevron { rotate: 90deg; }
@media (prefers-reduced-motion: reduce) { .bk-booking-chevron { transition: none; } }
.bk-booking-detail {
  display: flex;
  align-items: flex-start;
  gap: 1rem 2rem;
  flex-wrap: wrap;
  padding: 0.25rem 0.6rem 1.15rem 4.5rem;
}
.bk-booking-detail .bk-facts { gap: 0.35rem 1.25rem; font-size: 0.875rem; }
.bk-booking-detail .bk-facts dd { font-weight: 400; }
.bk-booking-detail .bk-booking-open { align-self: flex-start; }
.bk-booking-detail .bk-sub { display: inline; font-size: inherit; }
@media (max-width: 560px) {
  .bk-booking > summary { grid-template-columns: max-content minmax(0, 1fr) 1rem; }
  /* Both pinned: with the status wrapped under the name, auto-placement would otherwise carry
     the chevron down to the second row beside it instead of keeping it on the name's line. */
  .bk-booking-status { grid-row: 2; grid-column: 2; }
  .bk-booking-chevron { grid-row: 1; grid-column: 3; }
  .bk-booking-detail { padding-left: 0.6rem; }
}

/* Confirmation ticket: date block | facts, with a tear-off footer row for reference + calendar */
.bk-ticket {
  background: var(--bk-surface);
  border: 1px solid var(--bk-border);
  border-radius: var(--bk-radius);
  box-shadow: var(--bk-shadow);
  margin: 0 0 1rem;
  overflow: hidden;
}
.bk-ticket-top { display: flex; align-items: stretch; }
.bk-ticket-date {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.1rem;
  min-width: 6.5rem;
  padding: 1.25rem 1rem;
  background: var(--bk-surface-2);
  border-right: 1px dashed var(--bk-border);
}
.bk-ticket-month { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; color: var(--bk-accent); }
.bk-ticket-day { font-size: 2.3rem; font-weight: 700; line-height: 1.05; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.bk-ticket-time { font-size: 0.85rem; color: var(--bk-text-muted); font-variant-numeric: tabular-nums; }
.bk-ticket-body { flex: 1; min-width: 0; padding: 1.25rem 1.5rem; }
.bk-ticket-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.85rem 1.5rem;
  border-top: 1px dashed var(--bk-border);
  background: color-mix(in srgb, var(--bk-surface-2) 55%, var(--bk-surface));
}
.bk-ticket-ref { display: flex; align-items: baseline; gap: 0.5rem; }
.bk-ticket-ref .bk-mono { font-weight: 600; font-size: 1rem; letter-spacing: 0.04em; }
.bk-ticket-ref span:first-child { font-size: 0.8rem; color: var(--bk-text-muted); }
@media (max-width: 540px) {
  .bk-ticket-top { flex-direction: column; }
  .bk-ticket-date { flex-direction: row; gap: 0.5rem; align-items: baseline; justify-content: flex-start; padding: 0.9rem 1.5rem; border-right: 0; border-bottom: 1px dashed var(--bk-border); }
  .bk-ticket-day { font-size: 1.6rem; }
}

/* Manage page: sticky booking summary beside the actions column on wide screens */
.bk-cols { display: grid; gap: 1rem; align-items: start; }
@media (min-width: 800px) {
  .bk-cols { grid-template-columns: 17rem minmax(0, 1fr); }
  .bk-cols > .bk-col-side { position: sticky; top: 1rem; }
}
.bk-col-side .bk-facts { grid-template-columns: 1fr; gap: 0.1rem 0; }
.bk-col-side .bk-facts dt { margin-top: 0.65rem; }
.bk-col-side .bk-facts dt:first-child { margin-top: 0; }
.bk-main h1 { font-size: 1.6rem; line-height: 1.2; letter-spacing: -0.02em; font-weight: 600; margin: 0.5rem 0 0.35rem; text-wrap: balance; }
.bk-main h2 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  font-weight: 600;
  margin: 0 0 1rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--bk-text-muted);
}
.bk-lead { color: var(--bk-text-muted); margin: 0 0 1.5rem; font-size: 1rem; text-wrap: pretty; }
.bk-brand { margin: 0; font-size: 0.78rem; font-weight: 600; letter-spacing: 0.1em; color: var(--bk-text-muted); text-transform: uppercase; }
.bk-brand a { color: inherit; text-decoration: none; }
.bk-brand a:hover { text-decoration: underline; }
.bk-brand a:focus-visible { outline: none; box-shadow: var(--bk-focus); border-radius: 2px; }

.bk-card {
  background: var(--bk-surface);
  border: 1px solid var(--bk-border);
  border-radius: var(--bk-radius);
  box-shadow: var(--bk-shadow);
  padding: 1.5rem;
  margin: 0 0 1rem;
}
.bk-card--danger { border-color: color-mix(in srgb, var(--bk-danger) 45%, var(--bk-border)); }

.bk-facts { display: grid; grid-template-columns: max-content 1fr; gap: 0.6rem 1.5rem; margin: 0; }
.bk-facts dt { color: var(--bk-text-muted); font-size: 0.85rem; align-self: center; }
.bk-facts dd { margin: 0; font-weight: 500; font-size: 0.98rem; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }

.bk-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
  padding: 0.16rem 0.6rem;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 500;
  background: var(--bk-surface-2);
  color: var(--bk-text-muted);
  border: 1px solid transparent;
}
.bk-badge::before { content: ''; width: 0.45em; height: 0.45em; border-radius: 50%; background: currentColor; }
.bk-badge--ok { background: var(--bk-ok-soft); color: var(--bk-ok); }
.bk-badge--warn { background: var(--bk-warning-soft); color: var(--bk-warning); }
.bk-badge--danger { background: var(--bk-danger-soft); color: var(--bk-danger); }
.bk-badge--accent { background: var(--bk-accent-soft); color: var(--bk-accent); }

.bk-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  min-height: 2.75rem;
  padding: 0.5rem 1.1rem;
  border-radius: var(--bk-radius-sm);
  border: 1px solid color-mix(in srgb, var(--bk-accent) 85%, black);
  background: var(--bk-accent);
  color: var(--bk-accent-contrast);
  font: inherit;
  font-size: 0.92rem;
  font-weight: 500;
  cursor: pointer;
  text-decoration: none;
  box-shadow: 0 1px 2px rgb(20 21 26 / 0.12), inset 0 1px 0 rgb(255 255 255 / 0.12);
  transition: transform 140ms var(--bk-ease), filter 140ms ease, box-shadow 140ms ease;
}
@media (hover: hover) and (pointer: fine) {
  .bk-btn:hover:not([disabled]) { filter: brightness(1.08); }
}
.bk-btn:active:not([disabled]) { transform: scale(0.96); }
@media (prefers-reduced-motion: reduce) {
  .bk-btn { transition: none; }
  .bk-btn:active:not([disabled]) { transform: none; }
}
.bk-btn:focus-visible { outline: none; box-shadow: var(--bk-focus); }
.bk-btn[disabled] { opacity: 0.55; cursor: not-allowed; }
.bk-btn--secondary { background: var(--bk-surface); color: var(--bk-text); border-color: var(--bk-border); box-shadow: 0 1px 2px rgb(20 21 26 / 0.05); }
.bk-btn--danger { background: var(--bk-danger); border-color: var(--bk-danger); color: var(--bk-danger-contrast); }
.bk-btn--outline-danger { background: var(--bk-surface); color: var(--bk-danger); border-color: color-mix(in srgb, var(--bk-danger) 40%, var(--bk-border)); }

.bk-field { display: block; margin: 0 0 1rem; }
/* display:block above would otherwise beat the UA's [hidden] rule (the enhancer hides fields). */
.bk-field[hidden] { display: none; }
.bk-field > span { display: block; font-size: 0.85rem; font-weight: 500; margin-bottom: 0.3rem; }
.bk-hint { display: block; font-size: 0.8rem; color: var(--bk-text-muted); font-weight: 400; margin-top: 0.2rem; }
.bk-input, .bk-select {
  width: 100%;
  box-sizing: border-box;
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--bk-border);
  border-radius: var(--bk-radius-sm);
  background: var(--bk-surface);
  color: var(--bk-text);
  font: inherit;
  font-size: 0.95rem;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.bk-input:focus-visible, .bk-select:focus-visible { outline: none; border-color: var(--bk-accent); box-shadow: var(--bk-focus); }

.bk-alert { border-radius: var(--bk-radius-sm); border: 1px solid transparent; padding: 0.7rem 0.95rem; margin: 0 0 1rem; font-size: 0.95rem; }
.bk-alert--danger { background: var(--bk-danger-soft); color: var(--bk-danger); border-color: color-mix(in srgb, var(--bk-danger) 25%, transparent); }
.bk-alert--warn { background: var(--bk-warning-soft); color: var(--bk-warning); border-color: color-mix(in srgb, var(--bk-warning) 25%, transparent); }
.bk-alert--ok { background: var(--bk-ok-soft); color: var(--bk-ok); border-color: color-mix(in srgb, var(--bk-ok) 25%, transparent); }

.bk-sub { display: block; font-size: 0.78rem; font-weight: 400; color: var(--bk-text-muted); }
.bk-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
.bk-empty-state { display: grid; min-height: 7rem; place-items: center; border-radius: var(--bk-radius-sm); background: color-mix(in srgb, var(--bk-surface-2) 55%, transparent); color: var(--bk-text-muted); text-align: center; }
.bk-empty-state p { margin: 0; text-wrap: pretty; }
.bk-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
.bk-actions--split { justify-content: space-between; margin-top: 1.5rem; }
.bk-incident-list, .bk-incident-history { list-style: none; margin: 1rem 0; padding: 0; display: grid; gap: 0.75rem; }
.bk-incident-card { margin: 0; padding: 1.1rem; border-color: color-mix(in srgb, var(--bk-danger) 30%, var(--bk-border)); box-shadow: none; }
.bk-incident-card h3 { display: flex; align-items: center; gap: 0.6rem; margin: 0 0 0.4rem; font-size: 0.98rem; font-weight: 600; text-wrap: balance; }
.bk-incident-card .bk-actions { align-items: center; }
.bk-incident-action { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap-reverse; }
.bk-incident-action > .bk-hint { flex-basis: 100%; margin: 0; }
/* The note only has to be filled in when the operator has actually decided to resolve, so the
   enhancer hides it until the first click on Resolve and this keeps it full width once shown. */
.bk-incident-action .bk-field { flex-basis: 100%; margin: 0 0 0.6rem; }
.bk-incident-history li { padding: 0.7rem 0; border-bottom: 1px solid var(--bk-border); }
.bk-incident-history li:last-child { border-bottom: 0; }
.bk-spinner {
  width: 1.5rem; height: 1.5rem; border-radius: 50%;
  border: 3px solid var(--bk-border); border-top-color: var(--bk-accent);
  animation: bk-spin 0.9s linear infinite;
  margin-bottom: 0.75rem;
}
@keyframes bk-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .bk-spinner { animation-duration: 2.5s; } }

.bk-disclosure { border: 1px solid var(--bk-border); border-radius: var(--bk-radius-sm); margin: 0 0 0.75rem; background: var(--bk-surface); }
.bk-disclosure > summary { cursor: pointer; padding: 0.7rem 1rem; font-weight: 500; font-size: 0.95rem; list-style-position: inside; }
.bk-disclosure > summary:focus-visible { outline: none; box-shadow: var(--bk-focus); border-radius: var(--bk-radius-sm); }
.bk-disclosure > div { padding: 0 1rem 1rem; }

.bk-filter-clear { display: inline-flex; align-items: center; color: var(--bk-text-muted); font-size: 0.85rem; font-weight: 500; text-underline-offset: 0.18em; }
.bk-filter-clear:focus-visible { outline: none; box-shadow: var(--bk-focus); border-radius: 3px; }

/* Availability calendar. A tinted tile per day plus a used/capacity label under every number read
   as a heat map the operator had to decode; the number carries the day and a single dot carries
   its state, so a normal month is almost entirely plain text. */
.bk-days-layout { display: grid; gap: 2rem; align-items: start; }
.bk-months { display: grid; gap: 1rem; min-width: 0; }
.bk-month h3 { margin: 0 0 0.75rem; font-size: 0.95rem; font-weight: 600; letter-spacing: -0.01em; }
.bk-monthgrid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 0.2rem; }
.bk-dow { text-align: center; font-size: 0.68rem; font-weight: 500; color: var(--bk-text-muted); padding: 0.1rem 0 0.4rem; }
.bk-day {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 2.6rem;
  border-radius: 8px;
  color: var(--bk-text-muted);
  text-decoration: none;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: background-color 120ms ease;
}
@media (hover: hover) and (pointer: fine) {
  .bk-day:hover { background: var(--bk-surface-2); }
}
.bk-day:focus-visible { outline: none; box-shadow: var(--bk-focus); }
@media (prefers-reduced-motion: reduce) { .bk-day { transition: none; } }
.bk-day--empty { visibility: hidden; }
/* The dot is the whole state vocabulary: present means something is true of this day, and its
   color says which. A quiet day has no dot at all. */
.bk-day::after {
  content: '';
  position: absolute;
  bottom: 0.3rem;
  width: 0.28rem;
  height: 0.28rem;
  border-radius: 50%;
}
.bk-day--booked { color: var(--bk-text); font-weight: 600; }
.bk-day--booked::after { background: var(--bk-accent); }
.bk-day--adjusted { color: var(--bk-text); font-weight: 600; box-shadow: inset 0 0 0 1px var(--bk-warning); }
.bk-day--adjusted::after { background: var(--bk-warning); }
.bk-day--closed { color: var(--bk-danger); font-weight: 600; }
.bk-day--closed::after { background: var(--bk-danger); }
.bk-day--selected { background: var(--bk-text); color: var(--bk-bg); font-weight: 600; box-shadow: none; }
.bk-day--selected::after { background: var(--bk-bg); }
.bk-day-num { font-size: 0.875rem; }
.bk-legend { display: grid; gap: 0.15rem; margin: 1rem 0 0; font-size: 0.8rem; color: var(--bk-text-muted); }
.bk-legend span { display: flex; align-items: center; gap: 0.5rem; }
.bk-legend i { width: 0.4rem; height: 0.4rem; border-radius: 50%; }
.bk-legend-dot--booked { background: var(--bk-accent); }
/* Hollow so the ring reads as the adjusted mark, matching the ring on the day cell itself. */
.bk-legend-dot--adjusted { background: transparent; box-shadow: inset 0 0 0 1px var(--bk-warning); }
.bk-legend-dot--closed { background: var(--bk-danger); }
.bk-months .bk-disclosure { margin: 0; }
.bk-selection-hint { margin: -0.25rem 0 0; padding-bottom: 0.25rem; line-height: 1.5; }
.bk-day-editor { min-width: 0; }
.bk-day-form h2 { margin: 0 0 1rem; color: var(--bk-text); font-size: 1.1rem; font-weight: 600; letter-spacing: -0.02em; text-transform: none; }
.bk-day-form .bk-field { display: inline-block; margin: 0 0.75rem 1rem 0; }
.bk-day-form .bk-field .bk-input { width: auto; min-width: 8rem; }
.bk-day-form .bk-field .bk-input[type=number] { min-width: 5.5rem; width: 5.5rem; }
.bk-day-form .bk-actions { gap: 0.6rem; }
@media (min-width: 1024px) {
  .bk-days-layout { grid-template-columns: minmax(16rem, 20rem) minmax(0, 1fr); gap: 3rem; }
}
@media (max-width: 520px) {
  .bk-monthgrid { gap: 0.15rem; }
  .bk-day { min-height: 2.75rem; }
}
.bk-disclosure--bare { border: none; background: none; margin: 0 0 0.75rem; }
.bk-disclosure--bare > summary { display: flex; align-items: center; gap: 0.35rem; min-height: 2.5rem; box-sizing: border-box; padding: 0 0 0.4rem; color: var(--bk-text-muted); font-size: 0.85rem; list-style: none; }
.bk-disclosure--bare > summary::-webkit-details-marker { display: none; }
.bk-disclosure--bare > summary::before { content: '\\203a'; display: inline-block; transition: rotate 140ms var(--bk-ease); }
.bk-disclosure--bare[open] > summary::before { rotate: 90deg; }
@media (prefers-reduced-motion: reduce) { .bk-disclosure--bare > summary::before { transition: none; } }
.bk-disclosure--bare > div { padding: 0; }
.bk-day-detail { margin: 0 0 1.5rem; }
.bk-day-bookings { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; }
.bk-day-bookings li {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem;
  padding: 0.6rem 0; font-size: 0.9rem;
  border-bottom: 1px solid color-mix(in srgb, var(--bk-border) 55%, transparent);
}
.bk-day-bookings li a { margin-left: auto; }
/* Adjacent pager controls reduce pointer travel during repeated month comparison. */
.bk-pager { display: flex; align-items: center; gap: 0.25rem; margin-bottom: 0.9rem; }
.bk-pager h3 { order: -1; margin: 0 auto 0 0; font-size: 0.95rem; font-weight: 600; letter-spacing: -0.01em; }
.bk-pager .bk-btn { width: 1.9rem; min-height: 1.9rem; padding: 0; font-size: 1rem; }
.bk-month[hidden] { display: none; }
#bk-default { margin-top: 1.25rem; }
.bk-btn--sm { min-height: 2.75rem; padding: 0.4rem 0.75rem; font-size: 0.85rem; }
.bk-defaults { list-style: none; margin: 0.75rem 0 0; padding: 0; display: grid; gap: 0.5rem; }
.bk-defaults li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--bk-border);
  border-radius: var(--bk-radius-sm);
  font-size: 0.9rem;
}

/* Admin settings page */
.bk-pagehead { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.bk-pagehead .bk-lead { margin-bottom: 0; }
.bk-pagehead + section { margin-top: 1.5rem; }
.bk-backlink { margin: 0 0 0.5rem; font-size: 0.9rem; }
.bk-backlink a { color: var(--bk-accent); text-decoration: none; }
.bk-backlink a:hover { text-decoration: underline; }

/* Settings keep one section visible at a time; the tab strip scrolls on narrow screens rather
   than wrapping into a second navigation hierarchy. */
.bk-tabs { display: flex; flex-wrap: nowrap; gap: 1.5rem; margin: 0 0 2rem; overflow-x: auto; border-bottom: 1px solid var(--bk-border); scrollbar-width: none; }
.bk-tabs::-webkit-scrollbar { display: none; }
.bk-tabs a {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  box-sizing: border-box;
  padding: 0 0 0.7rem;
  margin-bottom: -1px;
  white-space: nowrap;
  color: var(--bk-text-muted);
  text-decoration: none;
  font-weight: 500;
  font-size: 0.92rem;
  border-bottom: 2px solid transparent;
  transition: color 100ms ease;
}
.bk-tabs a:hover { color: var(--bk-text); }
.bk-tabs a:focus-visible { outline: none; box-shadow: var(--bk-focus); }
.bk-tabs a[aria-current="page"] { color: var(--bk-text); border-bottom-color: var(--bk-text); }
.bk-settings-sections { min-width: 0; }
.bk-settings-sections > [hidden] { display: none; }
/* A settings section is a two-column form: the group's title on the left, its fields on the right,
   every control open. The gap between groups is the only separator; alignment does the rest. */
.bk-settings-form { max-width: 52rem; }
.bk-settings-form > h2 { margin: 0 0 0.25rem; font-size: 1.05rem; font-weight: 600; letter-spacing: -0.02em; text-transform: none; color: var(--bk-text); }
.bk-settings-form > .bk-hint { margin-bottom: 0.5rem; }
.bk-sgroup { display: grid; grid-template-columns: minmax(10rem, 14rem) 1fr; gap: 0.5rem 3rem; padding: 1.75rem 0; align-items: start; }
.bk-sgroup + .bk-sgroup { border-top: 1px solid var(--bk-border); }
.bk-sgroup-head h3 { margin: 0; font-size: 0.95rem; font-weight: 600; letter-spacing: -0.01em; color: var(--bk-text); }
.bk-sgroup-head .bk-hint { margin-top: 0.3rem; }
.bk-sgroup-fields { display: grid; gap: 1.1rem; max-width: 28rem; min-width: 0; }
.bk-sfield .bk-field { margin: 0; }
.bk-sfield .bk-input { width: auto; min-height: 2.5rem; }
.bk-sfield .bk-input[type=number] { width: 7rem; }
.bk-sfield .bk-input[type=time] { width: 8rem; }
.bk-sfield .bk-input--wide { width: 100%; }
.bk-sfield .bk-hint { margin-top: 0.3rem; }
.bk-sfield .bk-switch, .bk-sfield .bk-fieldset { margin: 0; }
.bk-sfield .bk-switch { min-height: 0; }
.bk-sfield-label { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.bk-sfield .bk-fieldset legend { margin-bottom: 0.4rem; }
/* The badge's own display would otherwise beat the hidden attribute the enhancer toggles. */
.bk-sfield-dirty[hidden], .bk-unsaved[hidden] { display: none; }
.bk-modified { display: inline-flex; align-items: baseline; gap: 0.5rem; font-size: 0.8rem; color: var(--bk-text-muted); margin-top: 0.3rem; }
@media (max-width: 40rem) {
  .bk-sgroup { grid-template-columns: 1fr; gap: 0.75rem; padding: 1.25rem 0; }
}

/* Service-specific values that override a shared block stay folded: the shared dial is the daily
   control, and an override is worth a click only when the operator is looking for it. */
.bk-overrides { margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid var(--bk-border); }
.bk-overrides > summary { cursor: pointer; font-size: 0.95rem; font-weight: 600; letter-spacing: -0.01em; color: var(--bk-text); }
.bk-overrides > .bk-hint { margin-top: 0.35rem; }
.bk-overrides .bk-sgroup:first-of-type { border-top: 0; padding-top: 1rem; }

/* Save is the step operators miss: once anything in the section changes, the bar pins to the
   bottom of the viewport and says so, and the edited field is flagged until the save lands. */
.bk-savebar {
  position: sticky;
  bottom: 0;
  margin: 1.5rem -0.85rem 0;
  padding: 0.75rem 0.85rem;
  background: var(--bk-bg);
  border-top: 1px solid var(--bk-border);
}
.bk-savebar-status { display: inline-flex; align-items: center; gap: 0.75rem; }
.bk-unsaved { font-size: 0.85rem; color: var(--bk-warning); }

/* Weekday pills: seven checkboxes read as a form, seven toggles read as a week. */
.bk-days { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.bk-days .bk-check {
  justify-content: center;
  min-width: 3rem;
  min-height: 2.4rem;
  margin: 0;
  padding: 0 0.6rem;
  border: 1px solid var(--bk-border);
  border-radius: 8px;
  background: var(--bk-surface);
  font-size: 0.85rem;
  color: var(--bk-text-muted);
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
.bk-days .bk-check:has(input:checked) {
  background: var(--bk-accent);
  border-color: var(--bk-accent);
  color: var(--bk-accent-contrast);
  font-weight: 500;
}
.bk-days .bk-check:has(input:focus-visible) { box-shadow: var(--bk-focus); }
.bk-days .bk-check input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
@media (prefers-reduced-motion: reduce) { .bk-days .bk-check { transition: none; } }

.bk-check { display: flex; align-items: center; gap: 0.5rem; min-height: 2.75rem; margin: 0 0 0.25rem; font-size: 0.92rem; cursor: pointer; }
.bk-check input { width: 1.1rem; height: 1.1rem; accent-color: var(--bk-accent); }
.bk-check input:focus-visible { outline: none; box-shadow: var(--bk-focus); border-radius: 2px; }
.bk-fieldset { border: 0; margin: 0; padding: 0; }
.bk-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.bk-fieldset legend { font-size: 0.85rem; font-weight: 500; margin-bottom: 0.3rem; padding: 0; }

.bk-switch { display: flex; align-items: center; gap: 0.6rem; min-height: 2.75rem; font-size: 0.92rem; font-weight: 500; cursor: pointer; }
.bk-switch input {
  appearance: none;
  flex: none;
  width: 2.4rem; height: 1.35rem;
  margin: 0;
  border-radius: 999px;
  background: var(--bk-border);
  position: relative;
  cursor: pointer;
  transition: background 150ms ease;
}
.bk-switch input::after {
  content: '';
  position: absolute;
  top: 2px; left: 2px;
  width: calc(1.35rem - 4px); height: calc(1.35rem - 4px);
  border-radius: 50%;
  background: var(--bk-surface);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.25);
  transition: translate 150ms var(--bk-ease);
}
.bk-switch input:checked { background: var(--bk-accent); }
.bk-switch input:checked::after { translate: 1.05rem 0; }
.bk-switch input:focus-visible { outline: none; box-shadow: var(--bk-focus); }
@media (prefers-reduced-motion: reduce) {
  .bk-switch input, .bk-switch input::after { transition: none; }
}

.bk-linkbtn {
  background: none; border: 0; padding: 0;
  color: var(--bk-accent);
  font: inherit; font-size: 0.85rem; font-weight: 500;
  text-decoration: underline;
  cursor: pointer;
}
.bk-linkbtn:focus-visible { outline: none; box-shadow: var(--bk-focus); border-radius: 2px; }

/* Calendar + slot picker injected by the manage-page enhancer at runtime */
.bk-cal-wrap { margin: 0 0 1rem; }
.bk-cal {
  display: block;
  max-width: 22rem;
  padding: 0.5rem;
  border: 1px solid var(--bk-border);
  border-radius: var(--bk-radius-sm);
  background: var(--bk-surface);
}
.bk-cal::part(header) { padding: 0.25rem 0.25rem 0.5rem; }
.bk-cal::part(heading) { font-size: 0.95rem; font-weight: 600; }
.bk-cal::part(button) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2.75rem;
  min-height: 2.75rem;
  border: 1px solid var(--bk-border);
  border-radius: var(--bk-radius-sm);
  background: var(--bk-surface);
  color: var(--bk-text);
  padding: 0.3rem;
  cursor: pointer;
}
.bk-cal::part(button):focus-visible { outline: none; box-shadow: var(--bk-focus); }
.bk-cal calendar-month {
  --color-accent: var(--bk-accent);
  --color-text-on-accent: var(--bk-accent-contrast);
  width: 100%;
}
.bk-cal calendar-month::part(head) { color: var(--bk-text-muted); font-size: 0.75rem; }
.bk-cal calendar-month::part(button) { border-radius: var(--bk-radius-sm); font-variant-numeric: tabular-nums; }
.bk-cal calendar-month::part(button):focus-visible { outline: none; box-shadow: var(--bk-focus); }
.bk-cal calendar-month::part(today) { font-weight: 700; color: var(--bk-accent); }
.bk-cal calendar-month::part(selected) { font-weight: 700; color: var(--bk-accent-contrast); }
.bk-cal calendar-month::part(disallowed) { color: var(--bk-text-muted); opacity: 0.45; text-decoration: line-through; }
.bk-cal-status { margin: 0.5rem 0 0; font-size: 0.85rem; color: var(--bk-text-muted); }
.bk-cal-status:empty { display: none; }
.bk-slots { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
.bk-slot {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.15rem;
  min-width: 4.5rem;
  min-height: 2.75rem;
  padding: 0.55rem 1rem;
  border: 1px solid var(--bk-border);
  border-radius: var(--bk-radius-sm);
  background: var(--bk-surface);
  color: var(--bk-text);
  font: inherit;
  cursor: pointer;
  box-shadow: 0 1px 2px rgb(20 21 26 / 0.05);
  transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease, transform 140ms var(--bk-ease), opacity 200ms var(--bk-ease), translate 200ms var(--bk-ease);
}
@starting-style {
  .bk-slot { opacity: 0; translate: 0 4px; }
}
@media (hover: hover) and (pointer: fine) {
  .bk-slot:hover { border-color: var(--bk-accent); }
}
.bk-slot:active { transform: scale(0.97); }
@media (prefers-reduced-motion: reduce) {
  .bk-slot { transition: none; }
  .bk-slot:active { transform: none; }
}
.bk-slot:focus-visible { outline: none; box-shadow: var(--bk-focus); }
.bk-slot[aria-pressed="true"] {
  border-color: var(--bk-accent);
  background: var(--bk-accent);
  color: var(--bk-accent-contrast);
}
.bk-slot[aria-pressed="true"] .bk-slot-hint { color: inherit; opacity: 0.85; }
.bk-slot-time { font-weight: 600; font-variant-numeric: tabular-nums; }
.bk-slot-hint { font-size: 0.75rem; color: var(--bk-warning); }

/* Printing is how a day's bookings get carried into the field, where there is no dashboard to tap.
   Paper keeps only what can still be read on it: navigation, tabs, forms and the theme toggle go,
   every disclosure is forced open so the contact details print with their row, and the list takes
   the full page width it no longer has to share with the shell. */
@media print {
  :root { color-scheme: light; }
  .bk-page { background: #ffffff; color: #000000; }
  .bk-skip,
  .bk-sidebar,
  .bk-masthead,
  .bk-tabs,
  .bk-theme-toggle,
  .bk-searchbar,
  .bk-admin-attention,
  .bk-filter-clear,
  .bk-booking-open,
  .bk-booking-chevron,
  form { display: none !important; }
  .bk-shell { display: block; min-height: 0; }
  .bk-shell-main { padding: 0; }
  .bk-main, .bk-main--shell, .bk-main--mid, .bk-main--wide, .bk-panel {
    max-width: none;
    padding: 0;
    margin: 0;
  }
  /* A closed <details> keeps its panel out of the flow, so paper would drop exactly the reference
     and contact details the printed copy exists for. Both the modern pseudo-element and the plain
     child selector are set: browsers implement the closed state one way or the other. */
  details > :not(summary) { display: block !important; }
  ::details-content { display: block !important; content-visibility: visible !important; }
  .bk-card, .bk-badge, .bk-booking { box-shadow: none; }
  .bk-booking { break-inside: avoid; border-bottom: 1px solid #cccccc; }
  .bk-booking > summary { min-height: 0; }
  /* The day the rows belong to is the one thing a loose printed page must never lose, so it reads
     as a heading and is never left stranded at the foot of a page. */
  .bk-daygroup > h3 {
    break-after: avoid;
    font-size: 1.05rem;
    letter-spacing: 0;
    text-transform: none;
    color: #000000;
  }
  a[href] { color: inherit; text-decoration: none; }
}
`;

// An absent cookie means "follow the OS" (prefers-color-scheme); the toggle only stores an
// explicit choice, and clearing it (System) deletes the cookie.
export type ThemePreference = 'light' | 'dark';

export const themeCookieName = 'bk_theme';

export function readThemePreference(request: Request): ThemePreference | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== themeCookieName) continue;
    const value = part.slice(eq + 1).trim();
    return value === 'light' || value === 'dark' ? value : undefined;
  }
  return undefined;
}
