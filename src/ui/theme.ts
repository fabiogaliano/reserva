// The whole visual system as one stylesheet string, served at assetsCss so pages can reference it
// as an external same-origin file (keeps CSP intact — no inline <style>). Every value routes
// through a --bk-* custom property so a client site can rebrand without touching reserva.
// The palettes themselves are not declared here: they are lifted from src/ui/tokens.css, the one
// place a --bk-* default may live, so this stylesheet and the components' CSS cannot drift.
import { darkTokens, lightTokens } from './generated/tokens.js';

export const themeCss = `
/* Every default sits inside :where() so it has zero specificity: a consumer's plain
   \`:root { --bk-accent: … }\` wins in both schemes without having to outrank these selectors. */
:where(:root) {
  /* Keeps native control chrome (select dropdowns, date pickers, scrollbars) in step with the
     token flip below — without it they stay light inside the dark theme. */
  color-scheme: light dark;${lightTokens}
}
/* Applies when the OS prefers dark and no theme is forced, or when the viewer picks dark via the
   bk_theme cookie (reflected onto <html data-theme> server-side for a flash-free first paint).
   The media rule skips a forced theme, and forced dark follows it, so at equal (zero)
   specificity a forced choice wins either way. Screen-only, so paper always gets light tokens. */
@media screen and (prefers-color-scheme: dark) {
  :where(:root:not([data-theme])) {${darkTokens}
  }
}
@media screen {
  :where(:root[data-theme="dark"]) {
    color-scheme: dark;${darkTokens}
  }
}
:where(:root[data-theme="light"]) { color-scheme: light; }

/* Focus is a solid outline in the element's own accent rather than a box-shadow: forced-colors
   mode drops box-shadows but repaints outlines in a system color, and reading var(--bk-accent)
   at each rule keeps the ring in step with an accent scoped below :root. The offset puts the
   ring on the surrounding surface, where the accent clears 3:1, instead of on the control. */

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
  outline: 2px solid var(--bk-accent);
  outline-offset: 2px;
  box-shadow: var(--bk-shadow);
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
/* The lead has no bottom margin on the band, so the body's pull-up on a following list would run
   the two together; --bk-text-muted is tuned for light surfaces, not this one. */
.bk-masthead .bk-lead + .bk-list { margin: 0.5rem 0 0; color: var(--bk-masthead-muted); }
.bk-masthead .bk-list, .bk-masthead .bk-list li::marker { color: var(--bk-masthead-muted); }

/* Per-viewer theme switch (System / Light / Dark), all three visible so a choice is one click.
   Server-rendered hidden; the enhancer reveals it so no-JS viewers get the OS default instead of a
   dead control. Glass on the dark masthead and the dark top bar alike. */
.bk-theme-toggle {
  display: inline-flex;
  gap: 0.15rem;
  padding: 0.2rem;
  border-radius: 10px;
  border: 1px solid rgb(255 255 255 / 0.1);
  background: rgb(255 255 255 / 0.06);
}
.bk-theme-toggle button {
  display: inline-grid;
  place-items: center;
  width: 2.1rem;
  height: 2rem;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--bk-masthead-muted);
  cursor: pointer;
  transition: background-color 100ms ease, color 100ms ease;
}
@media (hover: hover) and (pointer: fine) {
  .bk-theme-toggle button:hover { color: var(--bk-masthead-text); }
}
.bk-theme-toggle button[aria-pressed="true"] { background: rgb(255 255 255 / 0.12); color: var(--bk-masthead-text); }
.bk-theme-toggle button:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .bk-theme-toggle button { transition: none; } }
/* In-flow as the masthead's first row, right-aligned, so title text below can't underlap the
   control on a narrow screen. */
.bk-masthead .bk-theme-toggle { display: flex; width: fit-content; margin: 0 0 0.9rem auto; }
.bk-topbar .bk-theme-toggle { flex: none; margin-left: auto; }
/* Scoped higher than the display rules above so the server-rendered control stays hidden until
   the enhancer reveals it, no matter the source order of the context rules. */
.bk-theme-toggle[hidden],
.bk-masthead .bk-theme-toggle[hidden],
.bk-topbar .bk-theme-toggle[hidden] { display: none; }

.bk-main { max-width: 44rem; margin: 0 auto; padding: 1.75rem 1rem 4rem; }
.bk-main--mid { max-width: 56rem; }
.bk-main--wide { max-width: 72rem; }
.bk-main--raised { position: relative; margin-top: -2.75rem; padding-top: 0; }
.bk-main--shell { max-width: none; margin: 0; padding: 0; }

/* Operators revisit this surface throughout the day, so navigation stays stable while the work
   area favors scan speed over decorative chrome. Two destinations fit in one bar across the top,
   which leaves the full width to the work. */
.bk-shell { min-height: 100vh; }
.bk-topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 1.25rem;
  min-height: 3.5rem;
  padding: 0.35rem clamp(1rem, 3vw, 2rem);
  background: #101114;
  border-bottom: 1px solid rgb(255 255 255 / 0.08);
  box-sizing: border-box;
}
.bk-topbar-brand {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  flex: none;
  min-width: 0;
  max-width: 16rem;
  margin: 0;
  font-size: 0.9rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: #ededef;
  white-space: nowrap;
}
.bk-topbar-brand span { overflow: hidden; text-overflow: ellipsis; }
.bk-topbar-brand::before {
  content: '';
  flex: none;
  width: 0.62rem;
  height: 0.62rem;
  border-radius: 3px;
  background: #6975df;
  box-shadow: 0 0 14px color-mix(in srgb, #6975df 70%, transparent);
}
.bk-topbar-nav { display: flex; gap: 0.25rem; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.bk-topbar-nav::-webkit-scrollbar { display: none; }
.bk-topbar-nav a {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  min-height: 2.5rem;
  box-sizing: border-box;
  padding: 0 0.7rem;
  border-radius: 8px;
  color: #aeb1b8;
  text-decoration: none;
  font-size: 0.875rem;
  font-weight: 500;
  white-space: nowrap;
  transition: background-color 120ms ease, color 120ms ease;
}
@media (hover: hover) and (pointer: fine) {
  .bk-topbar-nav a:hover { background: rgb(255 255 255 / 0.06); color: #ededef; }
}
.bk-topbar-nav a[aria-current="page"] { background: rgb(255 255 255 / 0.1); color: #ffffff; }
/* Inset: the links scroll inside an overflow box that would clip an outer ring. */
.bk-topbar-nav a:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: -2px; }
.bk-topbar-nav svg { flex: none; opacity: 0.82; }
.bk-topbar-count {
  min-width: 1.2rem;
  padding: 0 0.4rem;
  box-sizing: border-box;
  border-radius: 999px;
  background: #e5484d;
  color: #ffffff;
  font-size: 0.7rem;
  font-weight: 600;
  line-height: 1.2rem;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
@media (prefers-reduced-motion: reduce) { .bk-topbar-nav a { transition: none; } }
@media (max-width: 560px) {
  .bk-topbar { gap: 0.75rem; }
  .bk-topbar-brand span { display: none; }
  .bk-topbar-nav svg { display: none; }
}
.bk-shell-main {
  width: 100%;
  max-width: 72rem;
  min-width: 0;
  margin: 0 auto;
  padding: 1.5rem 1rem 4rem;
  box-sizing: border-box;
}
@media (min-width: 880px) {
  .bk-shell-main { padding: 2rem clamp(1.5rem, 3vw, 2rem) 5rem; }
}
.bk-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin: 0 0 1.25rem; }
.bk-toolbar h1 { margin: 0; font-size: 1.25rem; font-weight: 600; letter-spacing: -0.01em; }
.bk-toolbar .bk-lead { margin: 0.15rem 0 0; font-size: 0.9rem; }
/* Bookings dashboard. The operator opens this many times a day, so the page states what it is and
   then gets out of the way: a title row, a tab strip, and one panel on screen at a time. */
.bk-admin-header { display: flex; align-items: flex-end; gap: 0.75rem 1rem; flex-wrap: wrap; margin: 0 0 1.25rem; }
.bk-admin-header h1 { margin: 0; font-size: 1.5rem; font-weight: 600; line-height: 1.2; letter-spacing: -0.025em; }
.bk-admin-date { margin: 0.2rem 0 0; color: var(--bk-text-muted); font-size: 0.9rem; }
/* Panels are all server-rendered and all but one carry [hidden], so the tab strip works as plain
   links before the enhancer upgrades it to an in-page toggle. */
.bk-panels > [hidden] { display: none; }

/* The totals strip: four figures an operator would otherwise count rows for. Each is a link to
   the view that explains it. */
.bk-glance {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: 0.75rem;
  max-width: 62rem;
  margin: 0 0 1.5rem;
}
.bk-glance[hidden] { display: none; }
.bk-glance a {
  display: grid;
  gap: 0.15rem;
  padding: 0.85rem 1rem;
  border: 1px solid var(--bk-border);
  border-radius: var(--bk-radius-sm);
  background: var(--bk-surface);
  color: var(--bk-text);
  text-decoration: none;
  transition: border-color 120ms ease;
}
@media (hover: hover) and (pointer: fine) {
  .bk-glance a:hover { border-color: color-mix(in srgb, var(--bk-accent) 45%, var(--bk-border)); }
}
.bk-glance a:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .bk-glance a { transition: none; } }
.bk-glance-label { font-size: 0.78rem; font-weight: 500; color: var(--bk-text-muted); }
.bk-glance-value { font-size: 1.35rem; font-weight: 600; line-height: 1.2; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.bk-glance-sub { min-height: 1.2em; font-size: 0.8rem; color: var(--bk-text-muted); font-variant-numeric: tabular-nums; }
.bk-glance a[data-tone="warn"] .bk-glance-value { color: var(--bk-warning); }
@media (max-width: 560px) {
  .bk-glance { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem; }
  .bk-glance a { padding: 0.7rem 0.8rem; }
  .bk-glance-value { font-size: 1.15rem; }
}

/* The attention banner names the problem where the operator already is, instead of a count they
   have to click through to understand. */
.bk-banner {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  max-width: 62rem;
  box-sizing: border-box;
  margin: 0 0 1.25rem;
  padding: 0.7rem 0.9rem;
  border: 1px solid color-mix(in srgb, var(--bk-danger) 28%, transparent);
  border-radius: var(--bk-radius-sm);
  background: var(--bk-danger-soft);
  color: var(--bk-danger);
  font-size: 0.9rem;
}
.bk-banner[hidden] { display: none; }
.bk-banner svg { flex: none; }
.bk-banner p { flex: 1 1 16rem; margin: 0; color: var(--bk-text); }
.bk-banner strong { color: var(--bk-danger); font-weight: 600; }
.bk-banner a { color: var(--bk-danger); font-weight: 600; text-underline-offset: 0.2em; white-space: nowrap; }
.bk-banner a:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 2px; border-radius: 3px; }
.bk-banner--warn { border-color: color-mix(in srgb, var(--bk-warning) 28%, transparent); background: var(--bk-warning-soft); color: var(--bk-warning); }
.bk-banner--warn strong, .bk-banner--warn a { color: var(--bk-warning); }
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

/* The list's toolbar: a period switch, one search box (its placeholder says what it searches),
   and a status chip per state with its count, so filtering is one click and never a form. */
.bk-filterbar { display: grid; gap: 0.75rem; max-width: 62rem; margin: 0 0 1.5rem; }
.bk-filterbar-row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
.bk-segmented {
  display: inline-flex;
  gap: 0.15rem;
  padding: 0.2rem;
  border-radius: calc(var(--bk-radius-sm) + 0.2rem);
  background: var(--bk-surface-2);
}
.bk-segmented a {
  display: inline-flex;
  align-items: center;
  min-height: 2.2rem;
  padding: 0 0.8rem;
  border-radius: var(--bk-radius-sm);
  color: var(--bk-text-muted);
  font-size: 0.875rem;
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
}
.bk-segmented a[aria-current="true"] { background: var(--bk-surface); color: var(--bk-text); box-shadow: 0 1px 2px rgb(20 21 26 / 0.1); }
.bk-segmented a:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 1px; }
.bk-search { position: relative; flex: 1 1 16rem; max-width: 26rem; }
.bk-search svg { position: absolute; left: 0.75rem; top: 50%; translate: 0 -50%; color: var(--bk-text-muted); pointer-events: none; }
.bk-search .bk-input { min-height: 2.6rem; padding-left: 2.25rem; padding-right: 2rem; }
.bk-kbd {
  position: absolute;
  right: 0.6rem;
  top: 50%;
  translate: 0 -50%;
  padding: 0.05rem 0.4rem;
  border: 1px solid var(--bk-border);
  border-radius: 5px;
  color: var(--bk-text-muted);
  font: 500 0.72rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  pointer-events: none;
}
.bk-kbd[hidden], .bk-search .bk-input:focus ~ .bk-kbd { display: none; }
.bk-chips { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
.bk-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 2rem;
  padding: 0 0.7rem;
  border: 1px solid var(--bk-border);
  border-radius: 999px;
  background: var(--bk-surface);
  color: var(--bk-text-muted);
  font-size: 0.82rem;
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
}
.bk-chip b { font-weight: 600; color: var(--bk-text); font-variant-numeric: tabular-nums; }
.bk-chip[aria-current="true"] { background: var(--bk-text); border-color: var(--bk-text); color: var(--bk-bg); }
.bk-chip[aria-current="true"] b { color: inherit; }
.bk-chip--empty { opacity: 0.55; }
.bk-chip:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 2px; }
.bk-chips .bk-filter-clear { margin-left: 0.35rem; min-height: 2rem; }
@media (max-width: 560px) {
  .bk-search { max-width: none; flex-basis: 100%; }
  .bk-kbd { display: none; }
  /* One swipeable line instead of three stacked rows of chips. */
  .bk-chips { flex-wrap: nowrap; overflow-x: auto; margin: 0 -1rem; padding: 0 1rem; scrollbar-width: none; }
}

/* Day-grouped booking list. Every row is a native <details>: the summary holds what an operator
   scans by and the panel holds the rest, so the list never grows a column for a detail that only
   matters on one booking in twenty. Works with scripting off; the enhancer only adds
   one-open-at-a-time. */
.bk-daygroup {
  margin: 0 0 1rem;
  background: var(--bk-surface);
  border: 1px solid var(--bk-border);
  border-radius: var(--bk-radius);
  box-shadow: var(--bk-shadow);
  /* clip rather than hidden: it rounds the header band and rows into the card without becoming a
     scroll container, which would stop the heading below from sticking. */
  overflow: clip;
}
/* Each day is its own card, so a day and its bookings read as one unit instead of rows loose on
   the page. The day stays pinned under the top bar while its rows scroll past, so a long day never
   leaves the operator guessing which date they are reading. */
.bk-daygroup > h3 {
  position: sticky;
  top: 3.5rem;
  z-index: 5;
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin: 0;
  padding: 0.6rem 1rem;
  background: var(--bk-surface-2);
  border-bottom: 1px solid var(--bk-border);
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: -0.005em;
  text-transform: none;
  color: var(--bk-text);
}
.bk-day-abs { font-weight: 500; color: var(--bk-text-muted); }
.bk-day-totals { margin-left: auto; font-size: 0.8rem; font-weight: 500; color: var(--bk-text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
/* Fixed tracks rather than auto: each summary is its own grid, and only fixed widths line the
   columns up from one row to the next. */
.bk-booking { border-bottom: 1px solid color-mix(in srgb, var(--bk-border) 70%, transparent); }
.bk-booking:last-child { border-bottom: 0; }
.bk-booking > summary {
  display: grid;
  grid-template-columns: 4.6rem minmax(0, 1fr) 4rem minmax(0, 14rem) 1rem;
  align-items: center;
  gap: 0.2rem 1rem;
  min-height: 3.25rem;
  padding: 0.6rem 1rem;
  list-style: none;
  cursor: pointer;
  transition: background-color 120ms ease;
}
.bk-booking > summary::-webkit-details-marker { display: none; }
@media (hover: hover) and (pointer: fine) {
  .bk-booking > summary:hover { background: color-mix(in srgb, var(--bk-surface-2) 55%, transparent); }
}
/* Inset: the day card clips anything drawn outside a row, which would cut an outer ring at its edges. */
.bk-booking > summary:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: -2px; }
.bk-booking[open] > summary { background: color-mix(in srgb, var(--bk-surface-2) 45%, transparent); }
@media (prefers-reduced-motion: reduce) { .bk-booking > summary { transition: none; } }
.bk-booking-time { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; }
.bk-booking-time small, .bk-daylist time small { margin-left: 0.2rem; font-size: 0.72rem; font-weight: 500; color: var(--bk-text-muted); }
.bk-booking-who { font-weight: 500; }
.bk-booking-sub { display: block; margin-top: 0.15rem; font-size: 0.85rem; color: var(--bk-text-muted); }
.bk-booking-guests { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.875rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bk-booking-guests svg { flex: none; color: var(--bk-text-muted); }
/* Only a status that is not the happy path earns a badge; a list of confirmed bookings stays quiet.
   Field tags and money badges share the slot, wrapping between badges rather than inside one. */
.bk-booking-status { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.35rem; justify-self: end; font-size: 0.85rem; white-space: nowrap; color: var(--bk-text-muted); }
.bk-booking-chevron { justify-self: end; color: var(--bk-text-muted); transition: rotate 160ms var(--bk-ease); }
.bk-booking[open] > summary .bk-booking-chevron { rotate: 90deg; }
@media (prefers-reduced-motion: reduce) { .bk-booking-chevron { transition: none; } }
/* A cancelled or expired row still answers "did they book?", but must not read as someone who
   is coming. */
.bk-booking--void :is(.bk-booking-time, .bk-booking-who, .bk-booking-sub, .bk-booking-guests) { opacity: 0.55; }
.bk-booking--void .bk-booking-time { text-decoration: line-through; text-decoration-thickness: 1px; }
.bk-booking--void > summary { background: color-mix(in srgb, var(--bk-surface-2) 35%, transparent); }
.bk-booking-detail {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 1rem 2rem;
  padding: 0.5rem 1rem 1.25rem 6.6rem;
}
.bk-booking-detail .bk-facts { grid-template-columns: max-content minmax(0, 1fr); gap: 0.45rem 1.5rem; font-size: 0.875rem; }
.bk-booking-detail .bk-facts dd { font-size: 0.875rem; font-weight: 400; }
.bk-booking-detail .bk-sub { display: inline; font-size: inherit; }
.bk-row-actions { display: flex; flex-direction: column; align-items: stretch; gap: 0.5rem; min-width: 10rem; }
.bk-row-actions .bk-btn { justify-content: space-between; }
/* Contact details are the reason a row gets opened, so they read as links at a glance. */
.bk-facts a, .bk-daylist a, .bk-link { color: var(--bk-accent-text); text-decoration: none; }
.bk-link { display: inline-flex; align-items: center; gap: 0.3rem; font-weight: 500; }
@media (hover: hover) and (pointer: fine) {
  :is(.bk-facts, .bk-daylist) a:hover, .bk-link:hover { text-decoration: underline; text-underline-offset: 0.18em; }
}
:is(.bk-facts, .bk-daylist) a:focus-visible, .bk-link:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 2px; border-radius: 2px; }
.bk-copy {
  display: inline-grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  margin: -0.4rem 0 -0.4rem 0.25rem;
  padding: 0;
  vertical-align: middle;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--bk-text-muted);
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}
.bk-copy[hidden] { display: none; }
@media (hover: hover) and (pointer: fine) {
  .bk-copy:hover { background: var(--bk-surface-2); color: var(--bk-text); }
}
.bk-copy:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 1px; }
.bk-copy--done { color: var(--bk-ok); }
.bk-copy { position: relative; }
.bk-copy-check, .bk-copy--done .bk-copy-icon { display: none; }
.bk-copy--done .bk-copy-check { display: block; }
.bk-copy--done::after {
  content: attr(data-copied);
  position: absolute;
  bottom: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
  background: var(--bk-text);
  color: var(--bk-surface);
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) { .bk-copy { transition: none; } }
@media (max-width: 560px) {
  .bk-booking > summary { grid-template-columns: 3.9rem minmax(0, 1fr) 1rem; }
  /* All pinned: auto-placement would otherwise carry the chevron down to a later row instead of
     keeping it on the name's line. */
  .bk-booking-guests { grid-row: 2; grid-column: 2; }
  .bk-booking-status { grid-row: 3; grid-column: 2; justify-self: start; justify-content: flex-start; }
  .bk-booking-status:empty { display: none; }
  .bk-booking-chevron { grid-row: 1; grid-column: 3; }
  .bk-booking-time small { display: block; margin: 0; }
  .bk-booking-detail { grid-template-columns: 1fr; padding-left: 1rem; }
  .bk-row-actions { flex-direction: row; flex-wrap: wrap; }
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
.bk-ticket-month { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.12em; color: var(--bk-accent-text); }
.bk-ticket-day { font-size: 2.3rem; font-weight: 700; line-height: 1.05; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.bk-ticket-time { font-size: 0.85rem; color: var(--bk-text-muted); font-variant-numeric: tabular-nums; }
.bk-ticket-body { flex: 1; min-width: 0; padding: 1.25rem 1.5rem; }
/* Its own row above the facts rather than absolutely positioned, so a long service title can never
   run underneath the badge. */
.bk-ticket-status { display: flex; justify-content: flex-end; margin: 0 0 0.75rem; }
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
.bk-brand a:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 2px; border-radius: 2px; }
.bk-brand-logo { display: inline-block; vertical-align: top; max-width: 100%; height: auto; }
/* The dark bands stay dark in both schemes, where a brand accent picked for light surfaces can
   fall under 3:1; their own text color is the ring that always reads there. After the rules
   above on purpose: .bk-brand a and .bk-topbar-nav a tie with this on specificity. */
:is(.bk-masthead, .bk-topbar) :is(a, button):focus-visible { outline-color: var(--bk-masthead-text); }

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
.bk-badge--accent { background: var(--bk-accent-soft); color: var(--bk-accent-text); }
/* A declared field's value, not a state: no dot, a hairline border and the body colour keep it
   from ever reading as a booking status. */
.bk-badge--field { color: var(--bk-text); border-color: var(--bk-border); }
.bk-badge--field::before { content: none; }

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
.bk-btn:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 2px; }
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
  transition: border-color 140ms ease;
}
.bk-input:focus-visible, .bk-select:focus-visible { border-color: var(--bk-accent); outline: 2px solid var(--bk-accent); outline-offset: 2px; }

.bk-alert { border-radius: var(--bk-radius-sm); border: 1px solid transparent; padding: 0.7rem 0.95rem; margin: 0 0 1rem; font-size: 0.95rem; }
.bk-alert--danger { background: var(--bk-danger-soft); color: var(--bk-danger); border-color: color-mix(in srgb, var(--bk-danger) 25%, transparent); }
.bk-alert--warn { background: var(--bk-warning-soft); color: var(--bk-warning); border-color: color-mix(in srgb, var(--bk-warning) 25%, transparent); }
.bk-alert--ok { background: var(--bk-ok-soft); color: var(--bk-ok); border-color: color-mix(in srgb, var(--bk-ok) 25%, transparent); }

/* Bulleted lines in a long-form message: markers hang outside the text column, so a wrapped line
   lines up under its own text instead of under the bullet. */
.bk-list { margin: 0 0 1rem; padding-left: 1.25rem; text-wrap: pretty; }
.bk-list:last-child { margin-bottom: 0; }
.bk-list li { padding-left: 0.2rem; }
.bk-list li + li { margin-top: 0.4rem; }
.bk-list li::marker { color: var(--bk-text-muted); }
.bk-lead + .bk-list { margin-top: -0.75rem; margin-bottom: 1.5rem; color: var(--bk-text-muted); }

.bk-sub { display: block; font-size: 0.78rem; font-weight: 400; color: var(--bk-text-muted); }
.bk-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
.bk-empty-state { display: grid; min-height: 7rem; place-items: center; border-radius: var(--bk-radius-sm); background: color-mix(in srgb, var(--bk-surface-2) 55%, transparent); color: var(--bk-text-muted); text-align: center; }
.bk-empty-state p { margin: 0; text-wrap: pretty; }
.bk-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
.bk-actions--split { justify-content: space-between; margin-top: 1.5rem; }
.bk-incident-list, .bk-incident-history { list-style: none; margin: 1rem 0; padding: 0; display: grid; gap: 0.75rem; }
/* An incident card answers three things in reading order: what broke and when, which booking it
   touched, and what the operator should do about it. Diagnostics stay folded at the foot. */
.bk-incident-card { display: grid; gap: 0.75rem; margin: 0; padding: 1.1rem 1.25rem; border-color: color-mix(in srgb, var(--bk-danger) 30%, var(--bk-border)); box-shadow: none; }
.bk-incident-card h3 { display: flex; align-items: center; gap: 0.4rem 0.6rem; flex-wrap: wrap; margin: 0; font-size: 1rem; font-weight: 600; text-wrap: balance; }
.bk-incident-when { margin-left: auto; font-size: 0.8rem; font-weight: 400; color: var(--bk-text-muted); font-variant-numeric: tabular-nums; }
.bk-incident-about { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.75rem; margin: 0; padding: 0.6rem 0.75rem; border-radius: var(--bk-radius-sm); background: var(--bk-surface-2); font-size: 0.875rem; }
.bk-incident-about .bk-mono { font-weight: 600; }
.bk-incident-about .bk-sub { display: inline; font-size: inherit; }
.bk-incident-about .bk-link { margin-left: auto; }
.bk-incident-todo { margin: 0; font-size: 0.9rem; text-wrap: pretty; }
.bk-incident-foot { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem 1rem; flex-wrap: wrap; }
.bk-incident-foot > .bk-disclosure { margin: 0; }
.bk-incident-card .bk-actions { align-items: flex-end; gap: 0.5rem; }
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
.bk-disclosure > summary { display: flex; align-items: center; gap: 0.6rem; min-height: 2.75rem; box-sizing: border-box; padding: 0.35rem 1rem; font-weight: 500; font-size: 0.95rem; list-style: none; cursor: pointer; }
.bk-disclosure > summary::-webkit-details-marker { display: none; }
.bk-disclosure > summary::before { content: '\\203a'; display: inline-block; width: 0.6rem; flex: none; color: var(--bk-text-muted); transition: rotate 140ms var(--bk-ease); }
.bk-disclosure[open] > summary::before { rotate: 90deg; }
@media (prefers-reduced-motion: reduce) { .bk-disclosure > summary::before { transition: none; } }
.bk-disclosure > summary:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 2px; border-radius: var(--bk-radius-sm); }
/* What is inside, said on the closed summary, so it only gets opened when that is worth it. */
.bk-disclosure-meta { margin-left: auto; font-size: 0.82rem; font-weight: 400; color: var(--bk-text-muted); text-align: right; font-variant-numeric: tabular-nums; }
.bk-disclosure > div { padding: 0 1rem 1rem; }
.bk-disclosure--bare { border: none; background: none; }
.bk-disclosure--bare > summary { gap: 0.35rem; min-height: 2.5rem; padding: 0; color: var(--bk-text-muted); font-size: 0.85rem; }
.bk-disclosure--bare > div { padding: 0; }

.bk-filter-clear { display: inline-flex; align-items: center; color: var(--bk-text-muted); font-size: 0.85rem; font-weight: 500; text-underline-offset: 0.18em; }
.bk-filter-clear:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 2px; border-radius: 3px; }

/* Availability calendar. Each day shows its number and one load bar: how full its busiest moment
   is, readable across a month without decoding a figure per cell. A ring marks an adjusted day and
   a struck-through number a closed one; the day card spells out the exact figures. */
.bk-days-layout { display: grid; gap: 2rem; align-items: start; }
.bk-calendar { min-width: 0; }
.bk-months { display: grid; gap: 1.25rem; min-width: 0; }
.bk-monthnav { display: flex; justify-content: space-between; gap: 1rem; margin-top: 0.75rem; font-size: 0.875rem; }
.bk-monthnav a:only-child { margin-left: auto; }
.bk-monthnav a:first-child:not(:only-child) { margin-right: auto; }
.bk-month h3 { margin: 0 0 0.5rem; font-size: 0.8rem; font-weight: 600; letter-spacing: 0.02em; color: var(--bk-text-muted); }
.bk-month[hidden] { display: none; }
.bk-months .bk-disclosure { margin: 0; }
/* touch-action leaves vertical swipes to the page and hands sideways drags to the range
   selection; user-select keeps a mouse drag from painting a text selection across the grid. */
.bk-monthgrid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 0.25rem; touch-action: pan-y; user-select: none; -webkit-user-select: none; }
.bk-dow { text-align: center; font-size: 0.68rem; font-weight: 500; color: var(--bk-text-muted); padding: 0.1rem 0 0.35rem; }
.bk-day {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  min-height: 3rem;
  border-radius: 8px;
  color: var(--bk-text);
  text-decoration: none;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  -webkit-touch-callout: none;
  transition: background-color 120ms ease;
}
/* Not on the selected day: its inverted fill is the one state a hover must never hide. */
@media (hover: hover) and (pointer: fine) {
  a.bk-day:not(.bk-day--selected):hover { background: var(--bk-surface-2); }
}
.bk-day:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .bk-day { transition: none; } }
.bk-day--empty { visibility: hidden; }
.bk-day--past { color: color-mix(in srgb, var(--bk-text-muted) 55%, transparent); cursor: default; }
.bk-day-num { font-size: 0.875rem; line-height: 1; }
/* Pinned to the foot of the cell so every bar in a week sits on one line, whatever the number
   above it is wearing (today's disc is taller than a plain digit). */
.bk-day > .bk-meter { position: absolute; left: 19%; bottom: 0.4rem; }
a.bk-day { padding-bottom: 0.35rem; box-sizing: border-box; }
.bk-day--today .bk-day-num { display: inline-grid; place-items: center; width: 1.7rem; height: 1.7rem; border-radius: 50%; background: var(--bk-accent-soft); color: var(--bk-accent-text); font-weight: 700; }
.bk-day--adjusted { box-shadow: inset 0 0 0 1px var(--bk-warning); }
.bk-day--closed { color: var(--bk-danger); }
.bk-day--closed .bk-day-num { text-decoration: line-through; text-decoration-thickness: 1.5px; }
.bk-day--selected { background: var(--bk-text); color: var(--bk-bg); box-shadow: none; }
.bk-day--selected.bk-day--today .bk-day-num { background: transparent; color: inherit; }
/* The fill width is a class hook on data-fill (tenths) rather than a style attribute, which the
   strict style-src CSP blocks. */
.bk-meter { display: block; width: 62%; height: 3px; border-radius: 2px; background: color-mix(in srgb, var(--bk-border) 80%, transparent); overflow: hidden; }
.bk-meter i { display: block; width: 0; height: 100%; border-radius: inherit; background: var(--bk-accent); }
.bk-meter[data-fill="10"] i { width: 10%; }
.bk-meter[data-fill="20"] i { width: 20%; }
.bk-meter[data-fill="30"] i { width: 30%; }
.bk-meter[data-fill="40"] i { width: 40%; }
.bk-meter[data-fill="50"] i { width: 50%; }
.bk-meter[data-fill="60"] i { width: 60%; }
.bk-meter[data-fill="70"] i { width: 70%; }
.bk-meter[data-fill="80"] i { width: 80%; }
.bk-meter[data-fill="90"] i { width: 90%; }
.bk-meter[data-fill="100"] i { width: 100%; }
.bk-meter--full i { background: var(--bk-warning); }
.bk-day--selected .bk-meter { background: color-mix(in srgb, var(--bk-bg) 30%, transparent); }
.bk-day--selected .bk-meter i { background: var(--bk-bg); }
.bk-meter--bar { width: 100%; height: 6px; border-radius: 3px; background: var(--bk-surface-2); }
.bk-legend { display: flex; flex-wrap: wrap; gap: 0.35rem 1rem; margin: 0.9rem 0 0; font-size: 0.78rem; color: var(--bk-text-muted); }
.bk-legend span { display: inline-flex; align-items: center; gap: 0.4rem; }
.bk-legend i { font-style: normal; }
.bk-legend-swatch { display: inline-block; width: 1.1rem; height: 3px; border-radius: 2px; background: var(--bk-accent); }
.bk-legend-swatch--full { background: var(--bk-warning); }
.bk-legend-ring { display: inline-block; width: 0.8rem; height: 0.8rem; border-radius: 3px; box-shadow: inset 0 0 0 1px var(--bk-warning); }
.bk-legend-strike { color: var(--bk-danger); text-decoration: line-through; font-variant-numeric: tabular-nums; }
.bk-selection-hint { margin: 0.5rem 0 0; line-height: 1.5; }
/* Two months at a time with a way back to today; adjacent controls keep pointer travel short
   while comparing months. */
.bk-pager { display: flex; align-items: center; gap: 0.25rem; }
.bk-pager h3 { margin: 0 auto 0 0; font-size: 0.95rem; font-weight: 600; letter-spacing: -0.01em; }
.bk-pager .bk-btn { width: 2.5rem; min-height: 2.5rem; padding: 0; font-size: 1.05rem; }
.bk-pager .bk-pager-today { width: auto; padding: 0 0.75rem; font-size: 0.82rem; }
@media (min-width: 1024px) {
  .bk-days-layout { grid-template-columns: minmax(18rem, 24rem) minmax(0, 1fr); gap: 2.5rem; }
}

/* The selected day as one card: what is booked, then how to change it. */
.bk-day-editor { display: grid; gap: 1rem; min-width: 0; }
.bk-daycard { border: 1px solid var(--bk-border); border-radius: var(--bk-radius); background: var(--bk-surface); box-shadow: var(--bk-shadow); }
.bk-daycard [hidden] { display: none; }
.bk-daycard-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.5rem 1rem; flex-wrap: wrap; padding: 1.1rem 1.25rem 0.9rem; border-bottom: 1px solid var(--bk-border); }
.bk-main .bk-daycard-head h2 { margin: 0; color: var(--bk-text); font-size: 1.1rem; font-weight: 600; letter-spacing: -0.02em; text-transform: none; }
.bk-daycard-head .bk-sub { margin-top: 0.2rem; font-size: 0.82rem; }
.bk-daycard-body { display: grid; gap: 1.25rem; padding: 1rem 1.25rem 1.25rem; }
.bk-daycard-body > .bk-alert { margin: 0; }
.bk-day-detail { display: grid; gap: 0.75rem; min-width: 0; }
.bk-day-detail .bk-hint { margin: 0; }
.bk-loadline { display: grid; gap: 0.4rem; }
.bk-loadline-top { display: flex; justify-content: space-between; gap: 1rem; font-size: 0.85rem; }
.bk-loadline-top span:last-child { color: var(--bk-text-muted); font-variant-numeric: tabular-nums; }
.bk-daylist { list-style: none; margin: 0; padding: 0; }
/* The name keeps a floor: an auto column takes its full width before a 1fr one gets any, so a
   row's badges would otherwise squeeze the name to nothing instead of wrapping. */
.bk-daylist li {
  display: grid;
  grid-template-columns: 4.2rem minmax(8rem, 1fr) auto auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.55rem 0;
  border-bottom: 1px solid color-mix(in srgb, var(--bk-border) 55%, transparent);
  font-size: 0.875rem;
}
.bk-daylist li:last-child { border-bottom: 0; }
.bk-daylist time { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bk-daylist strong { font-weight: 500; }
.bk-daylist .bk-sub { display: inline; margin-left: 0.35rem; font-size: 0.82rem; }
.bk-daylist-end { display: inline-flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 0.35rem 0.6rem; white-space: nowrap; }
.bk-editrow { display: flex; align-items: flex-end; gap: 0.75rem 1rem; flex-wrap: wrap; }
.bk-editrow .bk-field { margin: 0; }
.bk-field > label { display: block; font-size: 0.85rem; font-weight: 500; margin-bottom: 0.3rem; }
.bk-field--grow { flex: 1 1 14rem; }
.bk-stepper { display: inline-flex; align-items: stretch; border: 1px solid var(--bk-border); border-radius: var(--bk-radius-sm); background: var(--bk-surface); overflow: hidden; }
.bk-stepper:has(.bk-input:focus-visible) { outline: 2px solid var(--bk-accent); outline-offset: 2px; border-color: var(--bk-accent); }
.bk-stepper button { width: 2.75rem; min-height: 2.75rem; padding: 0; border: 0; background: transparent; color: var(--bk-text); font: inherit; font-size: 1.1rem; cursor: pointer; }
.bk-stepper button:first-child { border-right: 1px solid var(--bk-border); }
.bk-stepper button:last-child { border-left: 1px solid var(--bk-border); }
.bk-stepper button[hidden] { display: none; }
@media (hover: hover) and (pointer: fine) {
  .bk-stepper button:hover { background: var(--bk-surface-2); }
}
.bk-stepper button:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: -2px; }
.bk-stepper .bk-input { width: 4rem; min-height: 2.75rem; border: 0; border-radius: 0; font-weight: 600; text-align: center; font-variant-numeric: tabular-nums; -moz-appearance: textfield; }
/* The box around the number draws the ring; transparent rather than removed so forced-colors
   mode, which repaints it, still shows focus. */
.bk-stepper .bk-input:focus-visible, .bk-affix .bk-input:focus-visible { outline-color: transparent; }
.bk-stepper .bk-input::-webkit-inner-spin-button, .bk-stepper .bk-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.bk-editfoot { display: flex; align-items: center; gap: 0.6rem 0.75rem; flex-wrap: wrap; padding-top: 1rem; border-top: 1px solid var(--bk-border); }
.bk-editfoot .bk-hint { margin: 0; }
.bk-editfoot .bk-linkbtn { margin-left: auto; min-height: 2.75rem; color: var(--bk-text-muted); }
.bk-day-form h2 { margin: 0 0 1rem; color: var(--bk-text); font-size: 1.1rem; font-weight: 600; letter-spacing: -0.02em; text-transform: none; }
.bk-day-form .bk-field { display: inline-block; margin: 0 0.75rem 1rem 0; }
.bk-day-form .bk-field .bk-input { width: auto; min-width: 8rem; }
.bk-day-form .bk-field .bk-input[type=number] { min-width: 5.5rem; width: 5.5rem; }
.bk-day-form .bk-actions { gap: 0.6rem; }
@media (max-width: 520px) {
  .bk-monthgrid { gap: 0.15rem; }
  .bk-daycard-head, .bk-daycard-body { padding-inline: 1rem; }
  .bk-daylist li { grid-template-columns: 3.6rem minmax(0, 1fr) auto; }
  .bk-daylist-end { grid-column: 2 / -1; justify-content: flex-start; }
  .bk-editfoot .bk-linkbtn { margin-left: 0; }
}
#bk-default { margin: 0; }
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
.bk-tabs { display: flex; flex-wrap: nowrap; gap: 0.5rem; margin: 0 -0.5rem 2rem; overflow-x: auto; border-bottom: 1px solid var(--bk-border); scrollbar-width: none; }
.bk-tabs::-webkit-scrollbar { display: none; }
.bk-tabs a {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  box-sizing: border-box;
  padding: 0 0.5rem 0.7rem;
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
/* Inset for the same reason as the top bar links: the strip scrolls, and its overflow box clips.
   The tabs' inline padding (offset by the strip's negative margin) keeps the ring off the label. */
.bk-tabs a:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: -2px; }
.bk-tabs a[aria-current="page"] { color: var(--bk-text); border-bottom-color: var(--bk-text); }
.bk-settings-sections { min-width: 0; }
.bk-settings-sections > [hidden] { display: none; }
/* Wide screens list every section down the side, with how many values each one overrides, so
   the page doubles as a map of what has been changed. Narrow screens keep the tab strip. */
.bk-snav { display: none; }
.bk-snav a {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-height: 2.5rem;
  padding: 0 0.7rem;
  border-radius: var(--bk-radius-sm);
  color: var(--bk-text-muted);
  text-decoration: none;
  font-size: 0.9rem;
  font-weight: 500;
}
@media (hover: hover) and (pointer: fine) {
  .bk-snav a:hover { background: var(--bk-surface-2); color: var(--bk-text); }
}
.bk-snav a:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 2px; }
.bk-snav a[aria-current="page"] { background: var(--bk-surface); color: var(--bk-text); box-shadow: inset 0 0 0 1px var(--bk-border); }
.bk-snav-sep { height: 1px; margin: 0.5rem 0.7rem; background: var(--bk-border); }
.bk-snav-count { min-width: 1.25rem; padding: 0 0.35rem; box-sizing: border-box; border-radius: 999px; background: var(--bk-accent-soft); color: var(--bk-accent-text); font-size: 0.72rem; font-weight: 600; line-height: 1.25rem; text-align: center; font-variant-numeric: tabular-nums; }
.bk-settings-main { min-width: 0; }
@media (min-width: 1100px) {
  .bk-settings-layout { display: grid; grid-template-columns: 13rem minmax(0, 1fr); gap: 2.5rem; align-items: start; }
  .bk-snav { display: grid; gap: 0.1rem; position: sticky; top: 5rem; }
  .bk-settings-main > .bk-tabs { display: none; }
}
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
.bk-sfield-dirty[hidden] { display: none; }
/* The unit sits in the field rather than in the label, so the label names the setting and the
   field reads as the value it holds: "24 | hours". */
.bk-affix, .bk-field > .bk-affix { display: inline-flex; align-items: stretch; margin: 0; border: 1px solid var(--bk-border); border-radius: var(--bk-radius-sm); background: var(--bk-surface); font-size: inherit; font-weight: 400; overflow: hidden; }
.bk-affix:focus-within { outline: 2px solid var(--bk-accent); outline-offset: 2px; border-color: var(--bk-accent); }
.bk-affix .bk-input { border: 0; border-radius: 0; font-variant-numeric: tabular-nums; }
.bk-affix-unit { display: inline-flex; align-items: center; padding: 0 0.7rem; background: var(--bk-surface-2); color: var(--bk-text-muted); font-size: 0.85rem; white-space: nowrap; }
.bk-affix-unit:first-child { border-right: 1px solid var(--bk-border); }
.bk-affix-unit:last-child { border-left: 1px solid var(--bk-border); }
.bk-hint b { color: var(--bk-text); font-weight: 600; font-variant-numeric: tabular-nums; }
/* Prices by party size read as a table: pickups down the side, sizes across the top. */
.bk-sgroup-fields--wide { max-width: 36rem; overflow-x: auto; padding: 3px; margin: -3px; }
.bk-pricegrid { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
.bk-pricegrid th { padding: 0 0.75rem 0.5rem 0; text-align: left; font-size: 0.78rem; font-weight: 500; color: var(--bk-text-muted); white-space: nowrap; }
.bk-pricegrid td { padding: 0.4rem 0.75rem 0.4rem 0; border-top: 1px solid color-mix(in srgb, var(--bk-border) 60%, transparent); vertical-align: top; }
.bk-pricegrid tbody th { padding-top: 0.95rem; color: var(--bk-text); font-size: 0.875rem; }
.bk-sfield--cell .bk-input[type=number] { width: 6.5rem; }
/* Admin overview of a tagged field: one row per option, its link, and two booking counts. */
.bk-tagsection + .bk-tagsection { margin-top: 2rem; }
.bk-tagsection h2 { font-size: 1rem; margin: 0 0 0.75rem; }
.bk-tagtable { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
.bk-tagtable th { padding: 0 0.75rem 0.5rem 0; text-align: left; font-size: 0.78rem; font-weight: 500; color: var(--bk-text-muted); white-space: nowrap; }
.bk-tagtable td, .bk-tagtable tbody th { padding: 0.6rem 0.75rem 0.6rem 0; border-top: 1px solid color-mix(in srgb, var(--bk-border) 60%, transparent); vertical-align: middle; }
.bk-tagtable tbody th { color: var(--bk-text); font-size: 0.875rem; font-weight: 600; }
.bk-tagtable .bk-num { text-align: right; font-variant-numeric: tabular-nums; width: 1%; }
.bk-taglink { display: inline-flex; align-items: center; gap: 0.35rem; max-width: 100%; }
.bk-taglink a { overflow-wrap: anywhere; }
.bk-sfield--cell .bk-modified { display: flex; }
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

/* Save is the step operators miss: the bar is pinned to the bottom of the viewport, stays quiet
   while nothing has changed, and lifts and counts the edits once something has. */
.bk-savebar {
  position: sticky;
  bottom: 0;
  margin: 1.5rem -0.85rem 0;
  padding: 0.75rem 0.85rem;
  background: var(--bk-bg);
  border-top: 1px solid var(--bk-border);
  transition: box-shadow 160ms ease, background-color 160ms ease, border-color 160ms ease;
}
.bk-savebar[data-dirty] { background: var(--bk-surface); border-top-color: color-mix(in srgb, var(--bk-warning) 40%, var(--bk-border)); box-shadow: 0 -8px 24px rgb(20 21 26 / 0.08); }
.bk-savebar [hidden] { display: none; }
.bk-savebar .bk-btn[disabled] { opacity: 0.45; }
.bk-savebar-status { display: inline-flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.bk-savebar-msg { font-size: 0.85rem; color: var(--bk-text-muted); }
.bk-savebar[data-dirty] .bk-savebar-msg { color: var(--bk-warning); font-weight: 500; }
@media (prefers-reduced-motion: reduce) { .bk-savebar { transition: none; } }

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
.bk-days .bk-check:has(input:focus-visible) { outline: 2px solid var(--bk-accent); outline-offset: 2px; }
.bk-days .bk-check input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
@media (prefers-reduced-motion: reduce) { .bk-days .bk-check { transition: none; } }

.bk-check { display: flex; align-items: center; gap: 0.5rem; min-height: 2.75rem; margin: 0 0 0.25rem; font-size: 0.92rem; cursor: pointer; }
.bk-check input { width: 1.1rem; height: 1.1rem; accent-color: var(--bk-accent); }
.bk-check input:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 2px; border-radius: 2px; }
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
.bk-switch input:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 2px; }
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
.bk-linkbtn:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 2px; border-radius: 2px; }

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
.bk-cal::part(button):focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 2px; }
.bk-cal calendar-month {
  --color-accent: var(--bk-accent);
  --color-text-on-accent: var(--bk-accent-contrast);
  width: 100%;
}
.bk-cal calendar-month::part(head) { color: var(--bk-text-muted); font-size: 0.75rem; }
.bk-cal calendar-month::part(button) { border-radius: var(--bk-radius-sm); font-variant-numeric: tabular-nums; }
.bk-cal calendar-month::part(button):focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 2px; }
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
.bk-slot:focus-visible { outline: 2px solid var(--bk-accent); outline-offset: 2px; }
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
  .bk-topbar,
  .bk-masthead,
  .bk-tabs,
  .bk-theme-toggle,
  .bk-filterbar,
  .bk-banner,
  .bk-glance,
  .bk-copy,
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
  .bk-daygroup { background: none; border: 0; border-radius: 0; box-shadow: none; overflow: visible; }
  .bk-booking { break-inside: avoid; border-bottom: 1px solid #cccccc; }
  .bk-booking > summary, .bk-booking[open] > summary { min-height: 0; background: none; }
  /* The day the rows belong to is the one thing a loose printed page must never lose, so it reads
     as a heading and is never left stranded at the foot of a page. */
  .bk-daygroup > h3 {
    position: static;
    background: none;
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
