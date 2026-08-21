// UI primitives: DOM helper, icon set, toasts, the transient-layer manager that
// every menu/popover/context menu shares, the command palette and panel
// resizers. No framework, no dependencies.
import type { Command } from "./commands.js";

type Attrs = Record<string, string | number | boolean | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else node.setAttribute(key, String(value));
  }
  node.append(...children);
  return node;
}

/** Browser storage is optional in sandboxed/private contexts; UI state is not. */
export function safeStorageGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function safeStorageSet(key: string, value: string): boolean {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    // Callers decide whether this preference failure is benign or a durable
    // operation must remain pending and surface the error.
    return false;
  }
}

export async function copyText(text: string, success = "Copied"): Promise<boolean> {
  try {
    if (!globalThis.navigator?.clipboard) throw new Error("clipboard unavailable");
    await globalThis.navigator.clipboard.writeText(text);
    toast(success, "success");
    return true;
  } catch {
    toast("The browser blocked the clipboard", "error");
    return false;
  }
}

/** lucide-style stroke icons on a 24x24 grid, inheriting currentColor. */
const PATHS: Record<string, string> = {
  cube: '<path d="m12 2 9 5v10l-9 5-9-5V7Z"/><path d="m3 7 9 5 9-5M12 12v10"/>',
  frame: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/>',
  focus: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22"/><circle cx="12" cy="12" r="8"/>',
  camera: '<path d="M14.5 4h-5L8 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-4Z"/><circle cx="12" cy="13" r="3.5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  "eye-off": '<path d="M10.7 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-3.2 4.1M6.3 6.3A18 18 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 4.1-.9"/><path d="m3 3 18 18"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  ruler: '<path d="M16.5 2.5 21.5 7.5 7.5 21.5 2.5 16.5Z"/><path d="m7 12 2 2M10 9l2 2M13 6l2 2"/>',
  section: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M2 12h20" stroke-dasharray="3 2.5"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7Z"/><path d="m4 12-2 1 10 5 10-5-2-1"/><path d="m4 17-2 1 10 5 10-5-2-1"/>',
  bookmark: '<path d="M6 3.5h12v17l-6-4-6 4Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>',
  "check-circle": '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.3" r="1" fill="currentColor" stroke="none"/>',
  command: '<path d="M15 6a3 3 0 1 1 3 3h-3Zm0 0v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 1v2.5M12 20.5V23M1 12h2.5M20.5 12H23M4.2 4.2l1.8 1.8M18 18l1.8 1.8M19.8 4.2 18 6M6 18l-1.8 1.8"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>',
  settings: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/><circle cx="9" cy="6.5" r="2.1"/><circle cx="15.5" cy="12" r="2.1"/><circle cx="7.5" cy="17.5" r="2.1"/>',
  undo: '<path d="M9 5 4 10l5 5"/><path d="M4 10h9a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m15 5 5 5-5 5"/><path d="M20 10h-9a6 6 0 0 0 0 12h3"/>',
  upload: '<path d="M12 16V4M7.5 8.5 12 4l4.5 4.5"/><path d="M3 16v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/>',
  download: '<path d="M12 4v12M7.5 11.5 12 16l4.5-4.5"/><path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5Z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  "panel-left-open": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="m14 9 3 3-3 3"/>',
  "panel-left-close": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="m17 9-3 3 3 3"/>',
  "panel-right-open": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/><path d="m10 9-3 3 3 3"/>',
  "panel-right-close": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/><path d="m7 9 3 3-3 3"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  bot: '<path d="M12 3v3"/><rect x="4" y="6" width="16" height="14" rx="3"/><circle cx="9" cy="13" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="13" r="1.1" fill="currentColor" stroke="none"/><path d="M9.5 16.6h5"/>',
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5M13 15h4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 1 1 3.6 2.4c-.8.4-1.1 1-1.1 1.9"/><circle cx="12" cy="16.6" r="1" fill="currentColor" stroke="none"/>',
  message: '<path d="M21 14.5a2 2 0 0 1-2 2H8l-4 4V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-.7 4.6"/><path d="M20 4.5V11h-6.2"/>',
  table: '<rect x="3" y="4.5" width="18" height="15" rx="1.8"/><path d="M3 10h18M9.5 10v9.5"/>',
  shield: '<path d="M12 3l7.5 3v6c0 4.3-3 7.7-7.5 9-4.5-1.3-7.5-4.7-7.5-9V6Z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  gauge: '<path d="M4 17a8.6 8.6 0 1 1 16 0"/><path d="m12 13 4-3.5"/><circle cx="12" cy="16" r="1.4" fill="currentColor" stroke="none"/>',
  sparkle: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M18.5 15.5 19 17l1.5.5L19 18l-.5 1.5L18 18l-1.5-.5L18 17Z"/>',
  play: '<path d="M7 4.8v14.4l12-7.2Z"/>',
  chip: '<rect x="7" y="7" width="10" height="10" rx="1.6"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
  trash: '<path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l1 13h9l1-13"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.3l3.4 2"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  maximize: '<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/>',
  minimize: '<path d="M8 3v5H3M16 3v5h5M21 16h-5v5M8 21v-5H3"/>',
  plug: '<path d="M9 3v6M15 3v6"/><path d="M6.5 9h11v2.5a5.5 5.5 0 0 1-11 0Z"/><path d="M12 17v4"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.1"/><circle cx="10" cy="17" r="2.1"/>',
  funnel: '<path d="M3 5h18l-7 8.2V20l-4 1.6v-8.4Z"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1 0 1.6-.7 1.6-1.5 0-.4-.2-.8-.5-1.1-.3-.3-.4-.6-.4-1 0-.8.7-1.4 1.5-1.4H16a5 5 0 0 0 5-5c0-4.4-4-8-9-8Z"/><circle cx="7.5" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="10" cy="7.8" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="7.8" r="1.1" fill="currentColor" stroke="none"/>',
  clipboard: '<rect x="6" y="4.5" width="12" height="16" rx="2"/><path d="M9.5 4.5V3h5v1.5"/><path d="m9.5 12.5 2 2 3.5-4.5"/>',
  flag: '<path d="M5.5 21V3.6"/><path d="M5.5 4.6h12l-2.4 4 2.4 4h-12"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  edit: '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/><path d="m14.5 5.5 3 3"/>',
  blocks: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><path d="M17.25 14v6.5M14 17.25h6.5"/>',
  calculator: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7.5h8M8 12h.01M12 12h.01M16 12h.01M8 16.5h.01M12 16.5h.01M16 16.5h.01"/>',
  compare: '<path d="M9.5 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h4M14.5 4h4A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-4"/><path d="M12 2.5v19" stroke-dasharray="3 2.5"/>',
  ortho: '<rect x="3.5" y="7.5" width="13" height="13" rx="1.2"/><path d="M7.5 7.5V4.7a1.2 1.2 0 0 1 1.2-1.2h10.6a1.2 1.2 0 0 1 1.2 1.2v10.6a1.2 1.2 0 0 1-1.2 1.2H16.5"/><path d="m3.5 7.5 4-4M16.5 20.5l4-4"/>',
  walk: '<circle cx="13" cy="4.5" r="1.8"/><path d="M12.5 8.5 10 11l1.5 3.5L9 20M12.5 8.5l3 2 2.5 1M12.5 8.5 15 14l1.5 6M10 11l-3.5 1.5"/>',
  move: '<path d="M12 2v20M2 12h20"/><path d="m9 4.5 3-3 3 3M9 19.5l3 3 3-3M4.5 9l-3 3 3 3M19.5 9l3 3-3 3"/>',
  // The one mark that cannot be redrawn as strokes, so it fills instead and is
  // scaled from its own 16-grid onto the 24 one the rest of the set uses.
  github: '<path fill="currentColor" stroke="none" transform="translate(1 1) scale(1.375)" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>',
};

export function icon(name: string, size = 15): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = PATHS[name] ?? PATHS.info;
  return svg;
}

/**
 * A detail that would otherwise cost a paragraph: one icon, the words on hover.
 * Focusable, so the text is reachable without a pointer. `note` is the quieter
 * second line: why something is unavailable, or what it needs.
 */
export function infoIcon(text: string, name = "info", note = ""): HTMLElement {
  const mark = h("span", {
    class: "info-i",
    tabindex: "0",
    role: "note",
    // The bubble is a hover surface; the words have to reach a reader that
    // never hovers, so they are the element's own accessible name.
    "aria-label": note ? `${text} ${note}` : text,
  }, [icon(name, 12)]);
  attachTip(mark, text, note);
  return mark;
}

/**
 * Hover text placed beside its anchor instead of over the row it explains.
 * One bubble exists: it is moved, filled and flipped to the other side when it
 * would leave the window. A modal dialog paints above everything else, so the
 * bubble joins it there whenever the anchor lives inside one.
 */
let bubble: HTMLElement | null = null;
let tipAnchor: HTMLElement | null = null;

export function attachTip(anchor: HTMLElement, text: string, note = ""): void {
  const show = (): void => showTip(anchor, text, note);
  anchor.addEventListener("pointerenter", show);
  anchor.addEventListener("focus", show);
  anchor.addEventListener("pointerleave", hideTip);
  anchor.addEventListener("blur", hideTip);
}

// The pointer can leave a mark without the mark hearing about it: a rebuilt
// panel takes the hovered node away before pointerleave arrives. The bubble
// follows where the pointer actually is instead.
document.addEventListener(
  "pointermove",
  (e) => {
    if (!tipAnchor) return;
    const target = e.target as Node | null;
    if (!tipAnchor.isConnected || !target || !tipAnchor.contains(target)) hideTip();
  },
  true,
);

function showTip(anchor: HTMLElement, text: string, note: string): void {
  tipAnchor = anchor;
  const node = (bubble ??= h("span", { class: "tip anchored", role: "tooltip" }));
  node.replaceChildren(h("span", { text }), ...(note ? [h("span", { class: "no", text: note })] : []));
  (anchor.closest("dialog") ?? document.body).appendChild(node);
  // Measured from a corner: a bubble parked near the right edge would wrap
  // narrower than it will be once placed, and the flip would read it wrong.
  node.style.left = "0px";
  node.style.top = "0px";
  node.classList.add("on");
  const at = anchor.getBoundingClientRect();
  const box = node.getBoundingClientRect();
  const right = at.right + 10;
  const fits = right + box.width <= window.innerWidth - 8;
  node.style.left = `${fits ? right : Math.max(8, at.left - 10 - box.width)}px`;
  node.style.top = `${Math.min(Math.max(8, at.top + at.height / 2 - box.height / 2), Math.max(8, window.innerHeight - 8 - box.height))}px`;
}

function hideTip(): void {
  tipAnchor = null;
  bubble?.classList.remove("on");
}

/** A ring that turns while something is in flight. */
export function spinner(size = 12): HTMLElement {
  return h("span", { class: "spin", style: `width:${size}px;height:${size}px` });
}

/** One line saying a pane is working, for a pane with nothing to show yet. */
export function busyRow(text: string): HTMLElement {
  return h("div", { class: "busy-row" }, [spinner(13), h("span", { text })]);
}

export function iconButton(
  name: string,
  title: string,
  onClick: () => void,
  cls = "icon-btn",
): HTMLButtonElement {
  const btn = h("button", { class: cls, title, "aria-label": title, type: "button" }, [icon(name)]);
  btn.addEventListener("click", onClick);
  return btn;
}

/** The same chrome as iconButton, for something that leaves the page. */
export function iconLink(name: string, title: string, href: string, cls = "icon-btn"): HTMLAnchorElement {
  return h("a", { class: cls, title, "aria-label": title, href, target: "_blank", rel: "noopener noreferrer" }, [icon(name)]);
}

// -- transient layers -------------------------------------------------------
/**
 * One dropdown, popover or context menu is open at a time and any of them
 * closes on outside pointerdown, Escape, scroll or blur. Anchors count as
 * inside, so a toggle button can close what it opened.
 */
let layer: { nodes: HTMLElement[]; close: () => void; opener: HTMLElement | null } | null = null;

export function closeLayer(): void {
  const current = layer;
  layer = null;
  if (!current) return;
  // Focus lives inside what is about to be removed more often than not, so
  // hand it back to the control that opened the layer rather than to <body>.
  const inside =
    document.activeElement instanceof HTMLElement &&
    current.nodes.some((node) => node.contains(document.activeElement));
  current.close();
  if (inside && current.opener?.isConnected) current.opener.focus();
}

export function openLayer(nodes: HTMLElement[], close: () => void): void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  closeLayer();
  layer = { nodes, close, opener };
}

document.addEventListener(
  "pointerdown",
  (e) => {
    const target = e.target as Node | null;
    if (!layer || (target && layer.nodes.some((n) => n.contains(target)))) return;
    closeLayer();
  },
  true,
);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  hideTip();
  if (layer) {
    e.stopPropagation();
    closeLayer();
    return;
  }
  // Only once nothing transient is open, so Escape peels one thing at a time.
  if (pinned) {
    e.stopPropagation();
    closePinned();
  }
}, true);
window.addEventListener("blur", () => {
  hideTip();
  closeLayer();
});
window.addEventListener(
  "wheel",
  (e) => {
    // A bubble is placed against a rectangle that scrolling has just moved.
    hideTip();
    const target = e.target as Node | null;
    if (layer && !(target && layer.nodes.some((n) => n.contains(target)))) closeLayer();
  },
  { passive: true, capture: true },
);

// -- toasts -----------------------------------------------------------------
const TOAST_ICON = { info: "info", success: "check-circle", error: "alert" } as const;
let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: "info" | "success" | "error" = "info"): void {
  toastHost ??= h("div", { id: "toasts", role: "region", "aria-label": "Notifications" });
  // A modal dialog paints in the top layer, so a toast parked on <body> would
  // sit behind its backdrop. It rides with whatever is on top instead.
  const owner = document.querySelector<HTMLElement>("dialog[open]") ?? document.body;
  if (toastHost.parentElement !== owner) owner.appendChild(toastHost);
  while (toastHost.childElementCount > 2) toastHost.firstElementChild?.remove();
  const node = h("div", {
    class: `toast ${kind}`,
    role: kind === "error" ? "alert" : "status",
    "aria-atomic": "true",
  }, [icon(TOAST_ICON[kind], 14), h("span", { text: message })]);
  const remove = (): void => node.remove();
  node.addEventListener("click", remove);
  toastHost.appendChild(node);
  setTimeout(remove, kind === "error" ? 8000 : 3500);
}

// -- small form dialog ------------------------------------------------------
export interface FormField {
  key: string;
  label: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  /** Present for a fixed set of choices, which renders a select. */
  options?: string[];
}

/**
 * A one-shot modal for the two or three values an edit needs. Native <dialog>
 * so focus and Escape behave, removed on close so nothing accumulates.
 */
export function promptForm(
  title: string,
  fields: FormField[],
  confirmLabel: string,
  onSubmit: (values: Record<string, string>) => void,
): void {
  const dialog = h("dialog", { class: "form-dialog", "aria-label": title });
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const body = h("div", { class: "dlg-body" });
  for (const field of fields) {
    const input = field.options
      ? h("select", {}, field.options.map((option) =>
          h("option", { value: option, text: option, ...(option === field.value ? { selected: "" } : {}) })))
      : h("input", {
          type: "text",
          value: field.value ?? "",
          placeholder: field.placeholder ?? "",
        });
    if (field.options && field.value) (input as HTMLSelectElement).value = field.value;
    inputs.set(field.key, input as HTMLInputElement | HTMLSelectElement);
    body.appendChild(
      h("label", { class: "field" }, [
        h("span", { class: "field-label" }, [
          h("span", { text: field.label }),
          ...(field.hint ? [h("span", { class: "hint", text: field.hint })] : []),
        ]),
        input,
      ]),
    );
  }

  const cancel = h("button", { class: "btn", type: "button", text: "Cancel" });
  const confirm = h("button", { class: "btn primary", type: "button", text: confirmLabel });
  const submit = (): void => {
    const values: Record<string, string> = {};
    for (const [key, input] of inputs) values[key] = input.value.trim();
    dialog.close();
    onSubmit(values);
  };
  cancel.addEventListener("click", () => dialog.close());
  confirm.addEventListener("click", submit);
  body.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });

  dialog.append(
    h("div", { class: "dlg-head" }, [h("span", { text: title })]),
    body,
    h("div", { class: "dlg-foot" }, [cancel, confirm]),
  );
  dialog.addEventListener("close", () => dialog.remove());
  lightDismiss(dialog);
  document.body.appendChild(dialog);
  dialog.showModal();
  const first = inputs.values().next().value;
  if (first instanceof HTMLInputElement) first.select();
  else first?.focus();
}

// -- dropdown menus ---------------------------------------------------------
export interface MenuItem {
  label?: string;
  shortcut?: string;
  disabled?: boolean;
  separator?: boolean;
  run?: () => void;
}

/**
 * Close a modal dialog on a click outside its content. With `padding: 0` the
 * backdrop area is the dialog element itself, so target identity is enough.
 */
export function lightDismiss(dialog: HTMLDialogElement): void {
  dialog.addEventListener("mousedown", (e) => {
    if (e.target === dialog) dialog.close();
  });
}

/**
 * Yes or no over one sentence, for an action with nothing behind it. Native
 * <dialog> so Escape and focus behave; removed on close so nothing piles up.
 */
export function confirmAction(
  title: string,
  detail: string,
  confirmLabel: string,
  onConfirm: () => void,
): void {
  const dialog = h("dialog", { class: "form-dialog", "aria-label": title });
  const cancel = h("button", { class: "btn", type: "button", text: "Cancel" });
  const confirm = h("button", { class: "btn primary", type: "button", text: confirmLabel });
  cancel.addEventListener("click", () => dialog.close());
  confirm.addEventListener("click", () => {
    dialog.close();
    onConfirm();
  });
  dialog.append(
    h("div", { class: "dlg-head" }, [h("span", { text: title })]),
    h("div", { class: "dlg-body" }, [h("p", { class: "note", text: detail })]),
    h("div", { class: "dlg-foot" }, [cancel, confirm]),
  );
  dialog.addEventListener("close", () => dialog.remove());
  lightDismiss(dialog);
  document.body.appendChild(dialog);
  dialog.showModal();
  confirm.focus();
}

/** Up and down walk a menu, and opening one lands on its first entry. */
export function menuKeys(menu: HTMLElement, focusFirst = true): void {
  const rows = (): HTMLButtonElement[] => [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  menu.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const list = rows();
    if (list.length === 0) return;
    e.preventDefault();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    list[(at + step + list.length) % list.length].focus();
  });
  if (focusFirst) rows()[0]?.focus();
}

/** Build a dropdown list; the caller owns placement and dismissal. */
export function buildMenu(items: MenuItem[]): HTMLElement {
  const drop = h("div", { class: "menu-drop", role: "menu" });
  for (const item of items) {
    if (item.separator) {
      drop.appendChild(h("div", { class: "sep", role: "separator" }));
      continue;
    }
    const entry = h("button", { type: "button", role: "menuitem", disabled: item.disabled }, [
      h("span", { text: item.label ?? "" }),
    ]);
    if (item.shortcut) entry.appendChild(h("kbd", { text: item.shortcut }));
    entry.addEventListener("click", () => {
      closeLayer();
      item.run?.();
    });
    drop.appendChild(entry);
  }
  return drop;
}

/** Which side of its anchor a popover opens on. */
export type PopoverSide = "above" | "right";

/**
 * Anchor a popover panel to a button; the layer manager owns dismissal.
 * A vertical rail of icons opens its options sideways, so they land next to
 * the icon that owns them and never cover the tool below it.
 */
/**
 * The box a popover has to stay inside: the nearest ancestor that clips, or
 * the window. #viewer-host clips, so clamping to the window alone is what let
 * the filter chip's panel run off the side of the viewport and get cut.
 */
function clipBox(node: HTMLElement): { left: number; right: number; top: number; bottom: number } {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.overflow !== "visible" || style.overflowX !== "visible" || style.overflowY !== "visible") {
      const box = parent.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    }
  }
  return { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
}

/**
 * A panel that outlives clicks into the page. Rail tools are used against the
 * model, so a click in the viewport must not take the panel away; it closes on
 * its own button, on Escape, or when another pinned panel opens.
 */
let pinned: { close: () => void } | null = null;

export function closePinned(): void {
  const current = pinned;
  pinned = null;
  current?.close();
}

export interface PopoverOptions {
  /** Called with true just before the panel is built, false once it is gone. */
  onToggle?: (open: boolean) => void;
  /** Survives outside clicks, scrolling and focus loss. */
  pinned?: boolean;
}

export function attachPopover(
  button: HTMLButtonElement,
  build: (pop: HTMLElement, close: () => void) => void,
  side: PopoverSide = "above",
  options: PopoverOptions = {},
): void {
  const { onToggle, pinned: isPinned = false } = options;
  const item = button.parentElement ?? button;
  button.addEventListener("click", () => {
    if (button.getAttribute("aria-expanded") === "true") {
      return isPinned ? closePinned() : closeLayer();
    }
    // Before the panel is measured, so a host can make room for it.
    onToggle?.(true);
    const label = button.getAttribute("aria-label") || button.title || button.textContent?.trim() || "Options";
    const pop = h("div", { class: `pop ${side}`, role: "dialog", "aria-label": label });
    build(pop, () => (isPinned ? closePinned() : closeLayer()));
    item.appendChild(pop);
    button.setAttribute("aria-expanded", "true");
    // Keep the panel on screen when its anchor sits near an edge.
    const rect = pop.getBoundingClientRect();
    const box = clipBox(pop);
    const fit = (near: number, far: number, low: number, high: number): number =>
      near < low + 8 ? low + 8 - near : Math.min(0, high - 8 - far);
    if (side === "right") {
      const shift = fit(rect.top, rect.bottom, box.top, box.bottom);
      if (shift) pop.style.marginTop = `${shift}px`;
      const sideways = fit(rect.left, rect.right, box.left, box.right);
      if (sideways) pop.style.marginLeft = `${sideways}px`;
    } else {
      const shift = fit(rect.left, rect.right, box.left, box.right);
      if (shift) pop.style.marginLeft = `${shift}px`;
      const vertical = fit(rect.top, rect.bottom, box.top, box.bottom);
      if (vertical) pop.style.marginTop = `${vertical}px`;
    }
    const dismiss = (): void => {
      pop.remove();
      button.setAttribute("aria-expanded", "false");
      onToggle?.(false);
    };
    if (!isPinned) return openLayer([pop, button], dismiss);
    // One pinned panel at a time, and it must not sit under a menu or a
    // dropdown opened later, so any transient layer closes it first.
    closePinned();
    closeLayer();
    pinned = { close: dismiss };
  });
}

// -- context menu -----------------------------------------------------------
export interface ContextEntry {
  label?: string;
  count?: number;
  separator?: boolean;
  run?: () => void;
}

export function showContextMenu(
  x: number,
  y: number,
  title: Node | null,
  entries: ContextEntry[],
): void {
  const menu = h("div", { id: "ctxmenu", role: "menu" });
  if (title) menu.appendChild(h("div", { class: "head" }, [title]));
  for (const entry of entries) {
    if (entry.separator) {
      menu.appendChild(h("div", { class: "sep", role: "separator" }));
      continue;
    }
    const button = h("button", { type: "button", role: "menuitem" }, [h("span", { text: entry.label ?? "" })]);
    if (entry.count !== undefined) {
      button.appendChild(h("span", { class: "count", text: String(entry.count) }));
    }
    button.addEventListener("click", () => {
      closeLayer();
      entry.run?.();
    });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  openLayer([menu], () => menu.remove());
  menuKeys(menu);
}

// -- command palette --------------------------------------------------------
/**
 * Subsequence match with a small score: consecutive hits and word starts rank
 * above scattered ones. Cheap enough to run over every command per keystroke.
 */
function score(text: string, query: string): number {
  let points = 0;
  let at = 0;
  let streak = 0;
  for (const ch of query) {
    const found = text.indexOf(ch, at);
    if (found < 0) return -1;
    const isStart = found === 0 || text[found - 1] === " " || text[found - 1] === ".";
    points += (found === at ? 3 + streak : 1) + (isStart ? 4 : 0);
    streak = found === at ? streak + 1 : 0;
    at = found + 1;
  }
  return points - text.length * 0.02;
}

/** Rows rendered at once; the list is searched, not scrolled, past this. */
const MAX_ROWS = 120;

export class CommandPalette {
  private backdrop: HTMLElement | null = null;
  private matches: Command[] = [];
  /** Snapshot taken on open: building it per keystroke is what made it lag. */
  private pool: Command[] = [];
  private cursor = 0;
  /** Where focus came from, so closing puts it back rather than on <body>. */
  private opener: HTMLElement | null = null;

  /**
   * `source` is snapshotted when the palette opens; `dynamic` is asked on
   * every keystroke instead, which is what lets the palette reach a hundred
   * thousand elements without building a list of them up front.
   */
  constructor(
    private readonly source: () => Command[],
    private readonly dynamic?: (query: string) => Command[],
  ) {}

  isOpen(): boolean {
    return this.backdrop !== null;
  }

  toggle(): void {
    if (this.backdrop) this.close();
    else this.open();
  }

  close(): void {
    this.backdrop?.remove();
    this.backdrop = null;
    if (this.opener?.isConnected) this.opener.focus();
    this.opener = null;
  }

  open(): void {
    closeLayer();
    this.close();
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.cursor = 0;
    this.pool = this.source().filter((c) => !c.disabled);
    const input = h("input", {
      type: "text",
      placeholder: "Search commands, views, elements and properties",
      spellcheck: "false",
      role: "combobox",
      "aria-label": "Search commands",
      "aria-autocomplete": "list",
      "aria-controls": "palette-list",
      "aria-expanded": "true",
    });
    const list = h("div", { id: "palette-list", role: "listbox", "aria-label": "Commands" });
    const panel = h("div", {
      id: "palette",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Command palette",
    }, [
      h("div", { class: "pal-input" }, [icon("search", 15), input]),
      list,
    ]);
    const backdrop = h("div", { id: "palette-backdrop" }, [panel]);
    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) this.close();
    });
    document.body.appendChild(backdrop);
    this.backdrop = backdrop;

    const render = (): void => {
      const query = input.value.trim().toLowerCase();
      if (query) {
        const ranked: Array<{ command: Command; points: number }> = [];
        for (const command of this.pool) {
          const points = score(`${command.section} ${command.label} ${command.sub ?? ""}`.toLowerCase(), query);
          if (points >= 0) ranked.push({ command, points });
        }
        ranked.sort((a, b) => b.points - a.points);
        const found = ranked.slice(0, MAX_ROWS).map((r) => r.command);
        // Model results come after the commands: a keystroke that names a
        // command should not be pushed down the list by an element that
        // happens to share a word with it.
        const extra = query.length >= 2 ? (this.dynamic?.(query) ?? []) : [];
        this.matches = [...found, ...extra].slice(0, MAX_ROWS);
      } else {
        this.matches = this.pool.slice(0, MAX_ROWS);
      }
      this.cursor = Math.min(this.cursor, Math.max(0, this.matches.length - 1));

      const frag = document.createDocumentFragment();
      let section = "";
      let active: HTMLElement | null = null;
      this.matches.forEach((command, index) => {
        // Ranked results are already ordered by relevance, so only the
        // unfiltered list carries section headings.
        if (!query && command.section !== section) {
          section = command.section;
          frag.appendChild(h("div", { class: "pal-section", text: section, role: "presentation" }));
        }
        const item = h("button", {
          class: `pal-item${index === this.cursor ? " active" : ""}`,
          type: "button",
          id: `palette-option-${index}`,
          role: "option",
          "aria-selected": String(index === this.cursor),
        }, [icon(command.icon ?? "command", 14), h("span", { class: "grow", text: command.label })]);
        if (query) item.appendChild(h("span", { class: "sec", text: command.section }));
        if (command.sub) item.appendChild(h("span", { class: "sub", text: command.sub }));
        if (command.shortcut) item.appendChild(h("kbd", { text: command.shortcut }));
        item.addEventListener("click", () => this.execute(command));
        if (index === this.cursor) active = item;
        frag.appendChild(item);
      });
      if (this.matches.length === 0) {
        frag.appendChild(h("div", { class: "pal-section", text: "No matches", role: "status" }));
      }
      list.replaceChildren(frag);
      const activeItem = active as HTMLElement | null;
      if (activeItem) input.setAttribute("aria-activedescendant", activeItem.id);
      else input.removeAttribute("aria-activedescendant");
      activeItem?.scrollIntoView({ block: "nearest" });
    };

    input.addEventListener("input", () => {
      this.cursor = 0;
      render();
    });
    // Escape and Tab are bound to the panel, not the field: once focus moves
    // to a result row the palette must still be dismissable and still trap.
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        return this.close();
      }
      if (e.key !== "Tab") return;
      const stops = panel.querySelectorAll<HTMLElement>("input, button");
      if (stops.length === 0) return;
      const edge = e.shiftKey ? stops[0] : stops[stops.length - 1];
      if (document.activeElement !== edge) return;
      e.preventDefault();
      (e.shiftKey ? stops[stops.length - 1] : stops[0]).focus();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") return this.close();
      if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
        e.preventDefault();
        this.cursor = Math.min(this.cursor + 1, this.matches.length - 1);
        render();
      } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
        e.preventDefault();
        this.cursor = Math.max(this.cursor - 1, 0);
        render();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const command = this.matches[this.cursor];
        if (command) this.execute(command);
      }
    });
    render();
    input.focus();
  }

  private execute(command: Command): void {
    this.close();
    try {
      command.run();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
  }
}

// -- panel resizers ---------------------------------------------------------
/**
 * Drag-resize a panel by writing a CSS variable directly, so dragging never
 * goes through app state, and at most once per frame. The viewport picks the
 * new size up through its own ResizeObserver. Width persists across sessions.
 */
/**
 * A drag handle on one edge of a panel. `left` and `right` resize the width;
 * `top` resizes the height, for a panel docked across the bottom.
 */
export function makeResizer(options: {
  host: HTMLElement;
  side: "left" | "right" | "top";
  cssVar: string;
  storageKey: string;
  min: number;
  max: number;
}): void {
  const { host, side, cssVar, storageKey, min, max } = options;
  const vertical = side === "top";
  const stored = Number(safeStorageGet(storageKey));
  const clamp = (n: number): number => Math.min(max, Math.max(min, n));
  if (Number.isFinite(stored) && stored > 0) {
    document.documentElement.style.setProperty(cssVar, `${clamp(stored)}px`);
  }

  const handle = h("div", {
    class: `resizer ${vertical ? "top" : side === "left" ? "right" : "left"}`,
    role: "separator",
    tabindex: "0",
    "aria-label": "Resize panel",
    "aria-orientation": vertical ? "horizontal" : "vertical",
    "aria-valuemin": String(min),
    "aria-valuemax": String(max),
  });

  let queued = 0;
  let target = 0;
  const apply = (width: number): void => {
    target = clamp(width);
    handle.setAttribute("aria-valuenow", String(Math.round(target)));
    if (queued) return;
    queued = requestAnimationFrame(() => {
      queued = 0;
      document.documentElement.style.setProperty(cssVar, `${target}px`);
    });
  };
  // Persist the clamped target, not a re-measure: the CSS write is deferred to
  // a frame, so measuring here would store a width one step behind.
  const persist = (): void => {
    safeStorageSet(storageKey, String(Math.round(target)));
  };

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("is-resizing");
    const startX = vertical ? e.clientY : e.clientX;
    const box = host.getBoundingClientRect();
    const startWidth = vertical ? box.height : box.width;
    target = clamp(startWidth);
    const move = (ev: PointerEvent): void => {
      const at = vertical ? ev.clientY : ev.clientX;
      apply(startWidth + (side === "left" ? at - startX : startX - at));
    };
    const up = (): void => {
      handle.removeEventListener("pointermove", move);
      document.body.classList.remove("is-resizing");
      persist();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("lostpointercapture", up, { once: true });
  });

  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 25 : 10;
    const box = host.getBoundingClientRect();
    const width = vertical ? box.height : box.width;
    const less = vertical ? "ArrowDown" : "ArrowLeft";
    const more = vertical ? "ArrowUp" : "ArrowRight";
    if (e.key === less) apply(width + (side === "left" ? -step : step));
    else if (e.key === more) apply(width + (side === "left" ? step : -step));
    else if (e.key === "Home") apply(min);
    else if (e.key === "End") apply(max);
    else return;
    e.preventDefault();
    persist();
  });

  host.appendChild(handle);
}
