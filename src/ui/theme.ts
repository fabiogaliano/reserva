// The whole visual system as one stylesheet string, served at the assetsCss route so the
// server-rendered pages (confirmation/manage/admin) can reference it as an external same-origin
// file — no inline <style>, which keeps consumers' hash- or 'self'-based CSP policies intact.
// Every value routes through a --bk-* custom property so a client site can rebrand by overriding
// tokens in its own CSS without touching bookkit.
//
// Visual direction: Linear-style — indigo #5E6AD2 accent, cool neutral surfaces, hairline
// borders, tight sans typography, restrained shadows, and a near-black masthead with a soft
// accent glow. Font stack prefers Inter when the host provides it and falls back to the system
// sans (no external font requests: the strict-CSP pages stay dependency-free).

// The dark palette lives here once and is interpolated into both the OS-driven media query and the
// viewer-forced `[data-theme="dark"]` selector below, so the two can never drift apart.
const darkTokens = `
  --bk-bg: #0a0a0c;
  --bk-surface: #141517;
  --bk-surface-2: #1d1e21;
  --bk-text: #ededef;
  --bk-text-muted: #8a8f98;
  --bk-border: #2b2c30;
  --bk-accent: #7c86e2;
  --bk-accent-contrast: #14162b;
  --bk-accent-soft: #232647;
  --bk-danger: #f2a099;
  --bk-danger-contrast: #2a100e;
  --bk-danger-soft: #3a201e;
  --bk-warning: #e0b568;
  --bk-warning-soft: #362a13;
  --bk-ok: #8fd0a0;
  --bk-ok-soft: #1c3123;
  --bk-shadow: 0 1px 2px rgb(0 0 0 / 0.5), 0 8px 28px rgb(0 0 0 / 0.4);`;

export const themeCss = `
:root {
  /* Keeps native control chrome (select dropdowns, date pickers, scrollbars) in step with the
     token flip below — without it they stay light inside the dark theme. */
  color-scheme: light dark;
  --bk-font: "Inter", "Inter Variable", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --bk-bg: #f3f4f6;
  --bk-surface: #ffffff;
  --bk-surface-2: #eceef1;
  --bk-text: #282a30;
  --bk-text-muted: #63666d;
  --bk-border: #e0e2e6;
  --bk-accent: #5e6ad2;
  --bk-accent-contrast: #ffffff;
  --bk-accent-soft: #eceefb;
  --bk-danger: #b3261e;
  --bk-danger-contrast: #ffffff;
  --bk-danger-soft: #fbeae9;
  --bk-warning: #8a5a00;
  --bk-warning-soft: #f9efd8;
  --bk-ok: #1d7a3f;
  --bk-ok-soft: #e4f2e9;
  --bk-masthead-text: #ededef;
  --bk-masthead-muted: #8a8f98;
  --bk-masthead-brand: #a9b1ef;
  --bk-radius: 12px;
  --bk-radius-sm: 8px;
  --bk-shadow: 0 1px 2px rgb(20 21 26 / 0.05), 0 8px 28px rgb(20 21 26 / 0.05);
  --bk-focus: 0 0 0 3px color-mix(in srgb, var(--bk-accent) 50%, transparent);
  --bk-ease: cubic-bezier(0.16, 1, 0.3, 1);
}
/* Dark palette applies when the OS prefers dark AND the viewer hasn't forced a theme (no
   data-theme attribute), or whenever the viewer explicitly picks dark. The viewer's choice is a
   bk_theme cookie the server reflects onto <html data-theme> so first paint is already correct —
   these pages ship no inline theme script (strict CSP), so a JS-applied flip would flash first.
   :root[data-theme=…] carries higher specificity than the media-query :root, so a forced light
   theme still wins under a dark OS. */
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
}

/* Masthead: the near-black header band every server-rendered page opens with — same in both
   color schemes, with a soft accent glow bleeding in from the top corner. Content cards below
   pull up over its lower edge (bk-main--raised) for the overlapping-card layout. */
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

/* Per-viewer theme toggle (System → Light → Dark). Server-rendered hidden; the enhancer reveals
   and wires it (assetsJs route), so no-JS viewers never see a dead control and simply get the
   OS-driven default. Lives on the dark masthead (customer pages) or the dark sidebar (admin), so
   it borrows the same glass treatment as the masthead's secondary button. */
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
/* In-flow (not absolute) as the masthead's first row, right-aligned on its own line, so the brand
   line and title flow below it and can never underlap the control on a narrow screen. */
.bk-masthead .bk-theme-toggle { display: flex; width: fit-content; margin: 0 0 0.9rem auto; }
.bk-sidebar .bk-theme-toggle { margin-left: auto; }
@media (min-width: 880px) {
  .bk-sidebar .bk-theme-toggle { margin: auto 0 0.1rem; justify-content: center; }
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

/* App shell (admin surfaces): dark sidebar navigation + content pane. Collapses to a horizontal
   nav bar on small screens. */
.bk-shell { display: grid; min-height: 100vh; grid-template-rows: auto 1fr; }
@media (min-width: 880px) { .bk-shell { grid-template-columns: 14.5rem minmax(0, 1fr); grid-template-rows: none; } }
.bk-sidebar {
  background: #101114;
  border-bottom: 1px solid rgb(255 255 255 / 0.08);
  padding: 0.75rem 0.8rem;
  display: flex;
  align-items: center;
  gap: 0.15rem;
  overflow-x: auto;
}
@media (min-width: 880px) {
  .bk-sidebar {
    position: sticky;
    top: 0;
    height: 100vh;
    box-sizing: border-box;
    flex-direction: column;
    align-items: stretch;
    overflow-x: visible;
    border-bottom: 0;
    border-right: 1px solid rgb(255 255 255 / 0.08);
    padding: 1.1rem 0.8rem;
  }
}
.bk-sidebar-brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0.75rem 0 0.35rem;
  font-size: 0.88rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: #ededef;
  white-space: nowrap;
}
@media (min-width: 880px) { .bk-sidebar-brand { margin: 0.2rem 0.45rem 1.1rem; } }
.bk-sidebar-brand::before {
  content: '';
  flex: none;
  width: 0.6rem; height: 0.6rem;
  border-radius: 3px;
  background: #5e6ad2;
  box-shadow: 0 0 14px color-mix(in srgb, #5e6ad2 70%, transparent);
}
.bk-sidebar a {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.45rem 0.6rem;
  border-radius: 6px;
  color: #b4b6bc;
  text-decoration: none;
  font-size: 0.88rem;
  font-weight: 500;
  white-space: nowrap;
  transition: background-color 100ms ease, color 100ms ease;
}
.bk-sidebar a:hover { background: rgb(255 255 255 / 0.06); color: #ededef; }
.bk-sidebar a.bk-active { background: rgb(255 255 255 / 0.09); color: #ffffff; }
.bk-sidebar a:focus-visible { outline: none; box-shadow: var(--bk-focus); }
.bk-sidebar svg { flex: none; opacity: 0.8; }
.bk-sidebar-label { display: none; }
@media (min-width: 880px) {
  .bk-sidebar-label { display: block; margin: 1.1rem 0.6rem 0.35rem; font-size: 0.68rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.09em; color: #6e7076; }
}
.bk-shell-main { padding: 1.4rem 1.25rem 3rem; width: 100%; max-width: 78rem; margin: 0 auto; box-sizing: border-box; min-width: 0; }
.bk-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin: 0 0 1.25rem; }
.bk-toolbar h1 { margin: 0; font-size: 1.25rem; font-weight: 600; letter-spacing: -0.01em; }
.bk-toolbar .bk-lead { margin: 0.15rem 0 0; font-size: 0.9rem; }

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
  min-height: 2.5rem;
  padding: 0.45rem 1.1rem;
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
.bk-btn:active:not([disabled]) { transform: scale(0.98); }
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
  min-height: 2.5rem;
  padding: 0.45rem 0.7rem;
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

.bk-table-wrap { overflow-x: auto; margin: 0 -0.25rem; }
.bk-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
.bk-table th, .bk-table td { text-align: left; padding: 0.55rem 0.7rem; border-bottom: 1px solid var(--bk-border); white-space: nowrap; }
.bk-table td { font-variant-numeric: tabular-nums; }
.bk-table th { color: var(--bk-text-muted); font-size: 0.75rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; background: var(--bk-surface-2); }
.bk-table th:first-child { border-top-left-radius: 6px; }
.bk-table th:last-child { border-top-right-radius: 6px; }
.bk-table tbody tr { transition: background-color 100ms ease; }
.bk-table tbody tr:hover { background: var(--bk-surface-2); }
.bk-table a { color: var(--bk-accent); font-weight: 500; }
.bk-sub { display: block; font-size: 0.78rem; font-weight: 400; color: var(--bk-text-muted); }
.bk-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }

.bk-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; }
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

.bk-filters { display: grid; gap: 0.75rem; grid-template-columns: 1fr; margin: 0 0 1rem; }
@media (min-width: 640px) { .bk-filters { grid-template-columns: 2fr 1fr auto; align-items: end; } }
/* The fields' default bottom margin would sink the inputs above the button under align-items: end. */
.bk-filters .bk-field { margin: 0; }

/* Admin availability calendar: month grids of day cells linking to the adjust-day form */
.bk-days-layout { display: grid; gap: 1.5rem; align-items: start; }
@media (min-width: 880px) { .bk-days-layout { grid-template-columns: minmax(0, 1fr) 19rem; } }
.bk-months { display: grid; gap: 1.25rem; }
.bk-month h3 { margin: 0 0 0.5rem; font-size: 0.95rem; font-weight: 600; letter-spacing: -0.01em; }
.bk-monthgrid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 0.3rem; }
.bk-dow { text-align: center; font-size: 0.75rem; color: var(--bk-text-muted); text-transform: uppercase; letter-spacing: 0.04em; align-self: end; padding-bottom: 0.15rem; }
.bk-day {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.05rem;
  min-height: 3.1rem;
  border: 1px solid var(--bk-border);
  border-radius: var(--bk-radius-sm);
  background: var(--bk-surface);
  color: var(--bk-text);
  text-decoration: none;
  font-variant-numeric: tabular-nums;
  transition: border-color 120ms ease, background-color 120ms ease;
}
@media (hover: hover) and (pointer: fine) {
  .bk-day:hover { border-color: var(--bk-accent); }
}
.bk-day:focus-visible { outline: none; box-shadow: var(--bk-focus); }
@media (prefers-reduced-motion: reduce) { .bk-day { transition: none; } }
.bk-day--empty { visibility: hidden; }
.bk-day--quiet { color: var(--bk-text-muted); background: transparent; }
.bk-day--booked { border-color: color-mix(in srgb, var(--bk-accent) 45%, var(--bk-border)); background: var(--bk-accent-soft); }
.bk-day--adjusted { border-color: color-mix(in srgb, var(--bk-warning) 45%, var(--bk-border)); background: var(--bk-warning-soft); }
.bk-day--closed { border-color: color-mix(in srgb, var(--bk-danger) 35%, var(--bk-border)); background: var(--bk-danger-soft); color: var(--bk-danger); }
.bk-day--selected { box-shadow: var(--bk-focus); }
.bk-day-num { font-weight: 600; font-size: 0.9rem; }
/* Adjusted days get a dot next to the number so the state survives without color vision. */
.bk-day--adjusted .bk-day-num::after {
  content: ''; display: inline-block;
  width: 0.28rem; height: 0.28rem; margin-left: 0.18rem;
  border-radius: 50%; background: var(--bk-warning); vertical-align: 0.18em;
}
.bk-day-load { font-size: 0.75rem; color: var(--bk-text-muted); }
.bk-day--closed .bk-day-load { color: inherit; }
.bk-legend { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0 0 1rem; }
.bk-months .bk-disclosure { margin: 0; }
.bk-day-form h2 { margin-top: 0; }
/* Save spans the full row; Close/Reset share the second so the buttons never rag-wrap. */
.bk-day-form .bk-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
.bk-day-form .bk-actions .bk-btn:first-child { grid-column: 1 / -1; }
.bk-disclosure--bare { border: none; background: none; margin: 0 0 0.75rem; }
.bk-disclosure--bare > summary { padding: 0 0 0.5rem; color: var(--bk-text-muted); font-size: 0.85rem; }
.bk-disclosure--bare > div { padding: 0; }
.bk-day-detail { margin: 0 0 1rem; }
.bk-day-bookings { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
.bk-day-bookings li {
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem;
  padding: 0.45rem 0.6rem; font-size: 0.88rem;
  border: 1px solid var(--bk-border); border-radius: var(--bk-radius-sm);
}
.bk-day-bookings li a { margin-left: auto; }
/* Month pager (enhancer-built): the stacked/collapsed months are the no-JS fallback. Title left,
   both buttons grouped right so repeated paging needs no mouse travel. */
.bk-pager { display: flex; align-items: center; gap: 0.5rem; }
.bk-pager h3 { order: -1; margin: 0 auto 0 0; font-size: 0.95rem; font-weight: 600; }
.bk-month[hidden] { display: none; }
#bk-default { margin-top: 1.75rem; }
.bk-btn--sm { min-height: 2.1rem; padding: 0.25rem 0.7rem; font-size: 0.85rem; }
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

/* Settings: one section per tab. Tabs are underline-style links — hover fill + active accent
   underline so they read as controls, not labels. Fields stay one column on purpose; see
   settingsPage in handlers. */
/* No overflow/negative-margin tricks here: 1px of overflow makes overflow-x:auto grow a scrollbar
   on always-visible-scrollbar systems. The active underline sits flush above the bar border. */
.bk-tabs { display: flex; flex-wrap: wrap; gap: 0.25rem; margin: 0 0 1.25rem; border-bottom: 1px solid var(--bk-border); }
.bk-tabs a {
  padding: 0.55rem 0.95rem;
  white-space: nowrap;
  color: var(--bk-text-muted);
  text-decoration: none;
  font-weight: 500;
  font-size: 0.92rem;
  border-bottom: 2px solid transparent;
  border-radius: var(--bk-radius-sm) var(--bk-radius-sm) 0 0;
  transition: background-color 100ms ease, color 100ms ease;
}
.bk-tabs a:hover { background: var(--bk-surface-2); color: var(--bk-text); }
.bk-tabs a:focus-visible { outline: none; box-shadow: var(--bk-focus); }
.bk-tabs a[aria-current="page"] { color: var(--bk-text); border-bottom-color: var(--bk-accent); }
.bk-settings-sections { display: grid; gap: 1.25rem; min-width: 0; }
.bk-settings-sections .bk-card { margin: 0; }
.bk-settings-sections > [hidden] { display: none; }
.bk-section-hint { margin: -0.5rem 0 1.1rem; }
.bk-setting { margin: 0 0 1.15rem; }
.bk-setting:last-of-type { margin-bottom: 1.4rem; }
.bk-setting .bk-field, .bk-setting .bk-fieldset, .bk-setting .bk-switch { margin-bottom: 0.2rem; }
/* Numeric dials hold 2-4 digit values; full-width boxes read as free-text fields. */
.bk-setting .bk-input[type=number] { width: 7rem; }
.bk-setting-group { font-size: 0.95rem; font-weight: 600; margin: 1.6rem 0 0.95rem; }
.bk-setting-group:first-of-type { margin-top: 0.25rem; }
.bk-actions--split { justify-content: space-between; }

.bk-check { display: flex; align-items: center; gap: 0.5rem; margin: 0 0 0.5rem; font-size: 0.92rem; cursor: pointer; }
.bk-check input { width: 1.1rem; height: 1.1rem; accent-color: var(--bk-accent); }
.bk-check input:focus-visible { outline: none; box-shadow: var(--bk-focus); border-radius: 2px; }
.bk-fieldset { border: 0; margin: 0; padding: 0; }
.bk-fieldset legend { font-size: 0.85rem; font-weight: 500; margin-bottom: 0.3rem; padding: 0; }

.bk-switch { display: flex; align-items: center; gap: 0.6rem; font-size: 0.92rem; font-weight: 500; cursor: pointer; }
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

.bk-modified { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.35rem; font-size: 0.8rem; color: var(--bk-text-muted); }
.bk-linkbtn {
  background: none; border: 0; padding: 0;
  color: var(--bk-accent);
  font: inherit; font-size: 0.85rem; font-weight: 500;
  text-decoration: underline;
  cursor: pointer;
}
.bk-linkbtn:focus-visible { outline: none; box-shadow: var(--bk-focus); border-radius: 2px; }

/* Calendar + slot picker injected by the manage-page enhancer (assetsJs route) */
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
`;

// The per-viewer theme override. An absent cookie means "follow the OS" (prefers-color-scheme); the
// toggle only ever stores an explicit light/dark choice, and clearing it (System) deletes the
// cookie. Read server-side so <html data-theme> is correct on first paint.
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
