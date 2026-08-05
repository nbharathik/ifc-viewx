// Shared panel CSS, injected once per document. Every color comes from an
// --ifc-* variable that the host defines; the fallbacks below keep the panels
// legible on their own, so viewer-core stays usable outside this app.
const STYLE_ID = 'ifc-viewer-panel-styles';

const CSS = `
.ifc-panel {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  container-type: inline-size;
  font-family: var(--ifc-font, system-ui, sans-serif);
  color: var(--ifc-fg, #f4f6f9);
}
.ifc-panel__head { padding: 8px; flex: 0 0 auto; }
.ifc-panel__body { flex: 1 1 auto; overflow: auto; padding: 4px 8px 14px; }
.ifc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 30px 18px;
  text-align: center;
  color: var(--ifc-fg-3, #a5adbc);
}
.ifc-empty svg { width: calc(19px * var(--ui, 1)); height: calc(19px * var(--ui, 1)); opacity: 0.85; }
.ifc-empty .ifc-empty__sub { font-size: calc(11px * var(--ui, 1)); opacity: 0.92; max-width: 210px; }

/* Text field shared by the property filter and the tree search */
.ifc-input {
  width: 100%;
  padding: 5px 9px;
  background: var(--ifc-sunken, #08090b);
  color: inherit;
  border: 1px solid var(--ifc-line, #23272f);
  border-radius: var(--ifc-radius, 4px);
  font: inherit;
  outline: none;
}
.ifc-input::placeholder { color: var(--ifc-fg-3, #a5adbc); opacity: 0.85; }
.ifc-input:focus { border-color: var(--ifc-accent, #3b82f6); }

/* Tree search: one field holding the query, the hit count and its actions */
.ifc-search {
  display: flex;
  align-items: center;
  gap: 5px;
  height: calc(27px * var(--ui, 1));
  padding: 0 3px 0 8px;
  background: var(--ifc-sunken, #08090b);
  border: 1px solid var(--ifc-line, #23272f);
  border-radius: var(--ifc-radius, 4px);
}
.ifc-search:focus-within { border-color: var(--ifc-accent, #3b82f6); }
.ifc-search__icon { display: inline-flex; flex: 0 0 auto; color: var(--ifc-fg-3, #a5adbc); }
.ifc-search__icon svg { width: 12px; height: 12px; display: block; }
/* Doubled class: the host may style bare inputs, and this one is a bare box
   inside the field, not a field of its own. */
.ifc-search .ifc-search__input,
.ifc-search .ifc-search__input:focus {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0;
  background: none;
  border: none;
  border-radius: 0;
  outline: none;
  box-shadow: none;
  color: inherit;
  font: inherit;
}
.ifc-search__input::placeholder { color: var(--ifc-fg-3, #a5adbc); opacity: 0.85; }
.ifc-search__count {
  flex: 0 0 auto;
  font-size: calc(10.5px * var(--ui, 1));
  font-variant-numeric: tabular-nums;
  color: var(--ifc-fg-3, #a5adbc);
}
.ifc-search__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: calc(20px * var(--ui, 1));
  height: calc(20px * var(--ui, 1));
  padding: 0;
  background: none;
  border: none;
  border-radius: 3px;
  color: var(--ifc-fg-3, #a5adbc);
  cursor: pointer;
}
.ifc-search__btn svg { width: 13px; height: 13px; display: block; }
.ifc-search__btn:hover:not(:disabled) { background: var(--ifc-hover, rgba(255, 255, 255, 0.05)); color: var(--ifc-fg, #f4f6f9); }
.ifc-search__btn:disabled { opacity: 0.42; cursor: default; }
.ifc-search__btn[aria-pressed="true"] { background: var(--ifc-accent-soft, rgba(59, 130, 246, 0.15)); color: var(--ifc-accent, #3b82f6); }
.ifc-tree-label mark,
.ifc-tree-type mark {
  background: color-mix(in srgb, var(--ifc-accent, #3b82f6) 30%, transparent);
  border-radius: 2px;
  color: inherit;
}
/* Virtualized list: the spacer owns the full height, the window holds the
   rows currently on screen and is translated into place. */
.ifc-tree-scroll { position: relative; padding: 2px 6px 12px; overflow-y: auto; }
.ifc-tree-spacer { position: relative; width: 100%; }
.ifc-tree-window { position: absolute; top: 0; left: 0; right: 0; will-change: transform; }
.ifc-hidden { display: none; }
.ifc-tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  /* Fixed: tree.ts virtualization math (ROW_H) depends on exactly 22px. */
  height: 22px;
  padding: 0 4px;
  border-radius: var(--ifc-radius, 4px);
  cursor: default;
  white-space: nowrap;
  user-select: none;
}
.ifc-tree-row:hover { background: var(--ifc-hover, rgba(255, 255, 255, 0.05)); }
.ifc-tree-row--selected,
.ifc-tree-row--selected:hover {
  background: var(--ifc-accent-soft, rgba(59, 130, 246, 0.15));
  box-shadow: inset 2px 0 0 var(--ifc-accent, #3b82f6);
}
.ifc-tree-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
  cursor: pointer;
  color: var(--ifc-fg-3, #a5adbc);
}
.ifc-tree-toggle svg { width: 10px; height: 10px; transition: transform 120ms ease; }
.ifc-tree-toggle--open svg { transform: rotate(90deg); }
.ifc-tree-toggle--leaf { visibility: hidden; }
.ifc-tree-label {
  flex: 1 1 auto;
  min-width: 0;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ifc-tree-type {
  flex: 0 0 auto;
  margin-left: 6px;
  font-size: calc(10px * var(--ui, 1));
  color: var(--ifc-fg-3, #a5adbc);
}
.ifc-tree-eye {
  flex: 0 0 auto;
  cursor: pointer;
  opacity: 0;
  display: inline-flex;
  align-items: center;
  color: var(--ifc-fg-3, #a5adbc);
}
.ifc-tree-eye svg { width: 13px; height: 13px; display: block; }
.ifc-tree-row:hover .ifc-tree-eye { opacity: 0.85; }
.ifc-tree-eye:hover { color: var(--ifc-fg, #f4f6f9); opacity: 1; }
.ifc-tree-row--hidden .ifc-tree-eye { opacity: 0.85; }
.ifc-tree-row--hidden .ifc-tree-label { opacity: 0.6; }
/* Names win the space fight in a narrow panel; the type stays in Properties. */
@container (max-width: 240px) {
  .ifc-tree-type { display: none; }
}

/* Properties */
.ifc-selhead {
  position: sticky;
  top: -4px;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 8px 4px 9px;
  margin: -4px -8px 4px;
  padding-left: 12px;
  padding-right: 12px;
  background: var(--ifc-panel-bg, transparent);
  border-bottom: 1px solid var(--ifc-line, #23272f);
}
.ifc-selhead__name { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ifc-selhead__type { font-size: calc(11px * var(--ui, 1)); color: var(--ifc-fg-3, #a5adbc); }
.ifc-section { margin-bottom: 6px; }
.ifc-section__title {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 10px 4px 4px;
  background: none;
  border: none;
  font: inherit;
  font-size: calc(10px * var(--ui, 1));
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-align: left;
  cursor: pointer;
  color: var(--ifc-fg-3, #a5adbc);
}
.ifc-section__title:hover { color: var(--ifc-fg, #f4f6f9); }
.ifc-section__title::after {
  content: "";
  width: 5px;
  height: 5px;
  margin-left: auto;
  border-right: 1.4px solid currentColor;
  border-bottom: 1.4px solid currentColor;
  transform: rotate(45deg) translate(-1px, -1px);
  opacity: 0.6;
}
.ifc-section--closed .ifc-section__title::after { transform: rotate(-45deg) translate(-1px, 1px); }
.ifc-section--closed .ifc-row { display: none !important; }
.ifc-section__title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ifc-badge {
  flex: 0 0 auto;
  font-size: calc(9px * var(--ui, 1));
  letter-spacing: 0.04em;
  padding: 1px 5px;
  border-radius: 3px;
  border: 1px solid var(--ifc-line, #23272f);
  color: var(--ifc-fg-3, #a5adbc);
}
.ifc-row {
  display: grid;
  grid-template-columns: minmax(0, 40%) minmax(0, 1fr);
  gap: 10px;
  padding: 3px 4px;
  border-radius: var(--ifc-radius, 4px);
}
.ifc-row:hover { background: var(--ifc-hover, rgba(255, 255, 255, 0.05)); }
.ifc-key { color: var(--ifc-fg-3, #a5adbc); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ifc-val {
  color: var(--ifc-fg, #f4f6f9);
  word-break: break-word;
  font-variant-numeric: tabular-nums;
  cursor: copy;
}
.ifc-null { color: var(--ifc-fg-3, #a5adbc); opacity: 0.78; cursor: default; }

/* Measure + section handles */
.ifc-measuring canvas { cursor: crosshair; }
.ifc-over-handle canvas { cursor: grab; }
.ifc-dragging-section canvas { cursor: grabbing; }
/* One number over the middle of the span. Everything else about the
   measurement lives in the panel, where it does not sit on the model. */
.ifc-measure-label {
  position: absolute;
  transform: translate(-50%, -50%);
  padding: 3px 10px;
  background: var(--ifc-measure, #ff8c1a);
  color: #1a1205;
  border-radius: 999px;
  font-family: var(--ifc-mono, ui-monospace, monospace);
  font-size: calc(12px * var(--ui, 1));
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
  z-index: 9;
}
/* What the next click will catch, next to the cursor and easy to ignore. */
.ifc-snap-tag {
  position: absolute;
  transform: translate(12px, 10px);
  padding: 1px 6px;
  background: var(--ifc-surface, #171a20);
  color: var(--ifc-fg-2, #cbd1dc);
  border: 1px solid var(--ifc-line, #23272f);
  border-radius: 4px;
  font-family: var(--ifc-font, system-ui, sans-serif);
  font-size: calc(10px * var(--ui, 1));
  letter-spacing: 0.02em;
  white-space: nowrap;
  pointer-events: none;
  z-index: 9;
}

/* Plan inset: the pixels come from the WebGL pass, this is only its frame */
.ifc-plan-frame {
  position: absolute;
  border: 1px solid var(--ifc-line, #23272f);
  border-radius: 8px;
  box-shadow: var(--ifc-shadow, 0 8px 20px rgba(0, 0, 0, 0.4));
  pointer-events: none;
  z-index: 6;
}
.ifc-plan-frame span {
  position: absolute;
  top: 6px;
  left: 8px;
  font-family: var(--ifc-font, system-ui, sans-serif);
  font-size: calc(9px * var(--ui, 1));
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ifc-fg-3, #a5adbc);
}

/* Loading bar + error card */
.ifc-overlay {
  position: absolute;
  inset: 0;
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 10;
  font-family: var(--ifc-font, system-ui, sans-serif);
  color: var(--ifc-fg, #f4f6f9);
  pointer-events: none;
}
.ifc-overlay--visible { display: flex; }
/* The loading card sits at the top so streaming geometry stays visible. */
.ifc-overlay--top { align-items: flex-start; padding-top: 14px; }
.ifc-loading-card {
  min-width: 280px;
  padding: 11px 14px 12px;
  background: var(--ifc-surface, #171a20);
  border: 1px solid var(--ifc-line, #23272f);
  border-radius: 10px;
  box-shadow: var(--ifc-shadow, 0 10px 30px rgba(0, 0, 0, 0.5));
  pointer-events: auto;
}
.ifc-loading-head { display: flex; align-items: baseline; gap: 10px; }
.ifc-loading-title { font-weight: 550; }
.ifc-loading-detail { margin-left: auto; font-size: calc(11px * var(--ui, 1)); color: var(--ifc-fg-3, #a5adbc); }
.ifc-progress-track {
  height: 3px;
  border-radius: 2px;
  background: var(--ifc-line, #23272f);
  overflow: hidden;
  margin: 9px 0 0;
}
.ifc-progress-fill {
  height: 100%;
  width: 0%;
  border-radius: 2px;
  background: var(--ifc-accent, #3b82f6);
  transition: width 0.12s linear;
}
.ifc-cancel-btn {
  margin-top: 9px;
  font: inherit;
  font-size: calc(11px * var(--ui, 1));
  background: transparent;
  color: var(--ifc-fg-3, #a5adbc);
  border: 1px solid var(--ifc-line, #23272f);
  border-radius: 6px;
  padding: 3px 10px;
  cursor: pointer;
}
.ifc-cancel-btn:hover { color: var(--ifc-fg, #f4f6f9); }
.ifc-error-card {
  pointer-events: auto;
  max-width: 440px;
  background: var(--ifc-surface, #171a20);
  border: 1px solid var(--ifc-err, #f87171);
  border-radius: 10px;
  padding: 16px 18px;
  box-shadow: var(--ifc-shadow, 0 10px 30px rgba(0, 0, 0, 0.5));
}
.ifc-error-title { font-weight: 600; margin-bottom: 6px; color: var(--ifc-err, #f87171); }
.ifc-error-message { font-size: calc(11.5px * var(--ui, 1)); white-space: pre-wrap; word-break: break-word; color: var(--ifc-fg-2, #cbd1dc); }

/* Orientation gizmo: 2D canvas, so only its frame is styled here. */
.ifc-axis-gizmo {
  position: absolute;
  right: 10px;
  top: 10px;
  width: 68px;
  height: 68px;
  border-radius: 50%;
  transition: background var(--ifc-fast, 120ms) ease;
  z-index: 7;
}
.ifc-axis-gizmo:hover { background: var(--ifc-hover, rgba(255, 255, 255, 0.05)); }

/* Performance HUD */
.ifc-perf {
  position: absolute;
  right: 10px;
  top: 88px;
  width: 186px;
  display: none;
  padding: 8px 10px 9px;
  background: var(--ifc-surface, #171a20);
  border: 1px solid var(--ifc-line, #23272f);
  border-radius: 8px;
  box-shadow: var(--ifc-shadow, 0 10px 30px rgba(0, 0, 0, 0.5));
  font-family: var(--ifc-mono, monospace);
  font-size: calc(10.5px * var(--ui, 1));
  font-variant-numeric: tabular-nums;
  z-index: 7;
}
.ifc-perf--visible { display: block; }
.ifc-perf__title {
  font-family: var(--ifc-font, system-ui, sans-serif);
  font-size: calc(10px * var(--ui, 1));
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ifc-fg-3, #a5adbc);
  margin-bottom: 5px;
}
.ifc-perf__row { display: flex; justify-content: space-between; gap: 10px; padding: 1px 0; }
.ifc-perf__key { color: var(--ifc-fg-3, #a5adbc); }
.ifc-perf__sep { height: 1px; margin: 6px 0; background: var(--ifc-line, #23272f); }
`;

export function ensurePanelStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}
