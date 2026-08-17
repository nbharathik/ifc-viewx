// The parts a plugin panel is built from.
//
// Everything here is styled by the app, so a panel made of these pieces
// matches the rest of the viewer in both themes and at every UI scale without
// carrying a stylesheet of its own.
import { h, icon } from "../ui/kit.js";
import type { Value } from "./data.js";

export {
  attachPopover,
  attachTip,
  busyRow,
  confirmAction,
  h,
  icon,
  iconButton,
  infoIcon,
  promptForm,
  showContextMenu,
  spinner,
  toast,
} from "../ui/kit.js";
export type { FormField, MenuItem, PopoverSide } from "../ui/kit.js";
export { emptyState } from "../ui/shell.js";

/** The page every plugin panel is built inside. */
export function page(...children: Node[]): HTMLElement {
  return h("div", { class: "page plug-page" }, children);
}

/**
 * Hands the browser a frame to paint in. Await it between slices of a long
 * job and the panel stays responsive. The timer is the fallback that matters:
 * requestAnimationFrame never fires in a hidden tab, so a plugin waiting only
 * on it would stall the moment the user looks at something else.
 */
export const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, 50);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });

/** The heading every panel opens with: what it does, plus an optional tag. */
export function header(title: string, sub: string, tag = ""): HTMLElement {
  return h("header", { class: "plug-head" }, [
    h("div", { class: "grow" }, [h("h3", { text: title }), h("p", { text: sub })]),
    ...(tag ? [h("span", { class: "plug-tag", text: tag })] : []),
  ]);
}

/** A row of controls across the top of a panel. Strings become labels. */
export function bar(...children: Array<Node | string>): HTMLElement {
  return h("div", { class: "plug-bar" }, children.map((c) =>
    typeof c === "string" ? h("span", { class: "plug-bar-label", text: c }) : c,
  ));
}

export function button(label: string, run: () => void, kind = ""): HTMLButtonElement {
  const node = h("button", { class: `btn sm ${kind}`.trim(), type: "button", text: label });
  node.addEventListener("click", run);
  return node;
}

export function field(label: string, control: HTMLElement): HTMLElement {
  return h("label", { class: "plug-field" }, [h("span", { text: label }), control]);
}

export function select(
  options: Array<[string, string]>,
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const node = h("select", { class: "plug-select" });
  node.append(...options.map(([key, label]) => h("option", { value: key, text: label })));
  node.value = value;
  node.addEventListener("change", () => onChange(node.value));
  return node;
}

export function number(
  value: number,
  onChange: (value: number) => void,
  step = 1,
  min = 0,
): HTMLInputElement {
  const node = h("input", {
    type: "number",
    class: "plug-num",
    value: String(value),
    step: String(step),
    min: String(min),
  });
  node.addEventListener("change", () => onChange(Number(node.value)));
  return node;
}

export function search(placeholder: string, onInput: (value: string) => void): HTMLInputElement {
  const node = h("input", { type: "search", class: "plug-search-input", placeholder, spellcheck: "false" });
  node.addEventListener("input", () => onInput(node.value));
  return node;
}

export interface Progress {
  root: HTMLElement;
  set(done: number, total: number, label?: string): void;
  hide(): void;
}

export function progress(): Progress {
  const fill = h("i");
  const text = h("span", { class: "plug-progress-text" });
  const root = h("div", { class: "plug-progress hidden" }, [
    h("div", { class: "plug-progress-track" }, [fill]),
    text,
  ]);
  return {
    root,
    set(done, total, label) {
      root.classList.remove("hidden");
      const percent = total > 0 ? Math.round((done / total) * 100) : 0;
      fill.style.width = `${percent}%`;
      text.textContent = label ?? `${done.toLocaleString()} of ${total.toLocaleString()}`;
    },
    hide() {
      root.classList.add("hidden");
    },
  };
}

/** Headline numbers above a result table. */
export function stats(items: Array<[string, string, string?]>): HTMLElement {
  return h("div", { class: "plug-stats" }, items.map(([label, value, tone]) =>
    h("div", { class: `plug-stat${tone ? ` ${tone}` : ""}` }, [
      h("b", { text: value }),
      h("span", { text: label }),
    ]),
  ));
}

export interface GridRow {
  cells: Array<Value>;
  pick?: () => void;
  tone?: "err" | "warn" | "ok";
  title?: string;
}

/** A scrollable table with sticky headers; numbers align and format themselves. */
export function grid(headers: string[], rows: GridRow[], onSort?: (column: number) => void): HTMLElement {
  const head = h("tr", {}, headers.map((label, column) => {
    const cell = h("th", { text: label });
    if (onSort) {
      cell.classList.add("sortable");
      cell.addEventListener("click", () => onSort(column));
    }
    return cell;
  }));
  const body = h("tbody");
  for (const row of rows) {
    const tr = h("tr", { class: row.tone ?? "", title: row.title ?? "" });
    for (const value of row.cells) {
      const numeric = typeof value === "number";
      tr.appendChild(h("td", {
        class: numeric ? "num" : "",
        text: numeric ? formatNumber(value) : String(value ?? ""),
      }));
    }
    if (row.pick) {
      tr.classList.add("pick");
      tr.addEventListener("click", row.pick);
    }
    body.appendChild(tr);
  }
  return h("div", { class: "grid-wrap" }, [h("table", { class: "grid" }, [h("thead", {}, [head]), body])]);
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) return value.toLocaleString();
  const digits = Math.abs(value) >= 100 ? 1 : Math.abs(value) >= 1 ? 2 : 3;
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function note(text: string): HTMLElement {
  return h("div", { class: "note", text });
}

export function hint(iconName: string, text: string): HTMLElement {
  return h("div", { class: "plug-hint" }, [icon(iconName, 13), h("span", { text })]);
}

/** Multi-select list of IFC classes with counts. */
export function classPicker(
  counts: Array<[string, number]>,
  selected: Set<string>,
  onChange: () => void,
): HTMLElement {
  const list = h("div", { class: "plug-picker" });
  for (const [name, count] of counts) {
    const row = h("button", {
      class: "plug-pick",
      type: "button",
      "aria-pressed": String(selected.has(name)),
      title: `${name} (${count})`,
    }, [
      icon("check", 12),
      h("span", { class: "grow", text: name.replace(/^Ifc/, "") }),
      h("span", { class: "n", text: count.toLocaleString() }),
    ]);
    row.addEventListener("click", () => {
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
      row.setAttribute("aria-pressed", String(selected.has(name)));
      onChange();
    });
    list.appendChild(row);
  }
  return list;
}
