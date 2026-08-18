// The ribbon: a tab strip in the top bar and one slim strip of grouped
// commands under it. Tabs are data; every button points at a command id, so
// the ribbon holds no app state of its own.
//
// Collapsed, the strip takes no height. Selecting a tab expands it in place,
// so the controls always stay attached to the header. The choice persists.
import {
  buildMenu,
  closeLayer,
  h,
  icon,
  menuKeys,
  openLayer,
  safeStorageGet,
  safeStorageSet,
  type MenuItem,
} from "./kit.js";
import type { CommandRegistry } from "./commands.js";

export interface RibbonControl {
  el: HTMLElement;
  /** Called on every ribbon sync while the control is on screen. */
  sync?: () => void;
}

/**
 * Two sizes, and every button is labelled. One large button opens a group and
 * the rest stack small beside it; an unlabelled button next to a labelled one
 * reads as unfinished, so there is no icon-only size.
 */
export type RibbonSize = "lg" | "sm";

export type RibbonItem =
  | { kind: "cmd"; id: string; size?: RibbonSize; label?: string }
  | { kind: "menu"; label: string; icon: string; size?: RibbonSize; items: () => MenuItem[] }
  | { kind: "control"; build: () => RibbonControl };

export interface RibbonGroup {
  label: string;
  items: RibbonItem[];
}

export interface RibbonTab {
  id: string;
  label: string;
  groups: RibbonGroup[];
}

const COLLAPSE_KEY = "ifcviewx.ribbon.collapsed";
const TAB_KEY = "ifcviewx.ribbon.tab";
/** Small buttons stack this many per column before starting a new one. */
const STACK = 2;

export class Ribbon {
  private readonly strip: HTMLElement;
  private readonly tabButtons = new Map<string, HTMLButtonElement>();
  private readonly bound: Array<{ el: HTMLButtonElement; id: string }> = [];
  private readonly controls: RibbonControl[] = [];
  private readonly toggleBtn: HTMLButtonElement;
  private active: string;
  private collapsed = safeStorageGet(COLLAPSE_KEY) === "1";

  constructor(
    tabHost: HTMLElement,
    private readonly body: HTMLElement,
    private readonly registry: CommandRegistry,
    private readonly tabs: RibbonTab[],
  ) {
    if (!tabHost.hasAttribute("role")) tabHost.setAttribute("role", "tablist");
    if (!tabHost.hasAttribute("aria-label")) tabHost.setAttribute("aria-label", "Ribbon");
    this.strip = h("div", { class: "rib-strip" });
    this.body.appendChild(this.strip);

    for (const tab of tabs) {
      const button = h("button", {
        class: "rib-tab",
        type: "button",
        role: "tab",
        text: tab.label,
        "aria-selected": "false",
        "aria-controls": "ribbon",
        tabindex: "-1",
      });
      button.addEventListener("click", () => this.onTabClick(tab.id));
      button.addEventListener("dblclick", () => this.setCollapsed(!this.collapsed));
      button.addEventListener("keydown", (e) => this.onTabKey(e, tab.id));
      this.tabButtons.set(tab.id, button);
      tabHost.appendChild(button);
    }

    this.toggleBtn = h("button", {
      class: "rib-toggle",
      type: "button",
      title: "Collapse the ribbon  Ctrl+F1",
      "aria-label": "Collapse the ribbon",
    }, [icon("chevron", 14)]);
    this.toggleBtn.addEventListener("click", () => this.setCollapsed(!this.collapsed));
    tabHost.appendChild(this.toggleBtn);

    const stored = safeStorageGet(TAB_KEY);
    this.active = tabs.some((t) => t.id === stored) ? stored! : tabs[0].id;
    this.render();
    this.paintCollapsed();
  }

  /** Show a tab. A collapsed ribbon expands in place when a tab is chosen. */
  select(id: string, viaTab = false): void {
    if (this.active !== id) {
      this.active = id;
      safeStorageSet(TAB_KEY, id);
      this.render();
    }
    if (this.collapsed && viaTab) this.setCollapsed(false);
  }

  getTab(): string {
    return this.active;
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    safeStorageSet(COLLAPSE_KEY, collapsed ? "1" : "0");
    closeLayer();
    this.paintCollapsed();
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  /** Refresh enabled/pressed state of what is currently on screen. */
  sync(): void {
    for (const { el, id } of this.bound) {
      const enabled = this.registry.isEnabled(id);
      if (el.disabled === enabled) el.disabled = !enabled;
      const pressed = String(this.registry.isPressed(id));
      if (el.getAttribute("aria-pressed") !== pressed) el.setAttribute("aria-pressed", pressed);
      el.classList.toggle("off", !this.registry.isAvailable(id));
    }
    for (const control of this.controls) control.sync?.();
  }

  private onTabClick(id: string): void {
    this.select(id, true);
  }

  /** Roving focus keeps the tab strip to one stop while arrows switch tabs. */
  private onTabKey(e: KeyboardEvent, id: string): void {
    const at = this.tabs.findIndex((tab) => tab.id === id);
    const next =
      e.key === "ArrowRight" ? (at + 1) % this.tabs.length
      : e.key === "ArrowLeft" ? (at - 1 + this.tabs.length) % this.tabs.length
      : e.key === "Home" ? 0
      : e.key === "End" ? this.tabs.length - 1
      : -1;
    if (at < 0 || next < 0) return;
    e.preventDefault();
    const tab = this.tabs[next];
    this.select(tab.id, true);
    this.tabButtons.get(tab.id)?.focus();
  }

  private paintCollapsed(): void {
    this.body.classList.toggle("collapsed", this.collapsed);
    this.toggleBtn.classList.toggle("up", this.collapsed);
    this.toggleBtn.setAttribute("aria-expanded", String(!this.collapsed));
    this.body.setAttribute("aria-hidden", String(this.collapsed));
    this.toggleBtn.title = this.collapsed ? "Pin the ribbon  Ctrl+F1" : "Collapse the ribbon  Ctrl+F1";
  }

  private render(): void {
    const tab = this.tabs.find((t) => t.id === this.active) ?? this.tabs[0];
    for (const [id, button] of this.tabButtons) {
      const on = id === tab.id;
      button.classList.toggle("active", on);
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
    }
    this.body.setAttribute("aria-label", tab.label);
    this.bound.length = 0;
    this.controls.length = 0;

    const frag = document.createDocumentFragment();
    tab.groups.forEach((group, index) => {
      if (index > 0) frag.appendChild(h("span", { class: "rib-sep" }));
      frag.appendChild(this.buildGroup(group));
    });
    this.strip.replaceChildren(frag);
    this.sync();
  }

  private buildGroup(group: RibbonGroup): HTMLElement {
    const items = h("div", { class: "rib-items" });
    let stack: HTMLElement | null = null;
    for (const item of group.items) {
      const size = item.kind === "control" ? "lg" : item.size ?? "lg";
      if (size === "lg") {
        stack = null;
        items.appendChild(this.buildItem(item, "lg"));
        continue;
      }
      if (!stack || stack.childElementCount >= STACK) {
        stack = h("div", { class: "rib-stack" });
        items.appendChild(stack);
      }
      stack.appendChild(this.buildItem(item, "sm"));
    }
    return h("div", { class: "rib-group" }, [items, h("div", { class: "rib-glabel", text: group.label })]);
  }

  private buildItem(item: RibbonItem, size: RibbonSize): HTMLElement {
    if (item.kind === "control") {
      const control = item.build();
      this.controls.push(control);
      return control.el;
    }
    if (item.kind === "menu") {
      const button = this.button(item.icon, item.label, size, true);
      button.addEventListener("click", () => {
        if (button.getAttribute("aria-expanded") === "true") return closeLayer();
        // The ribbon strip clips its overflow, so a drop parked inside the
        // anchor would be cut off after a few pixels. It lives on <body> and
        // is placed against the button instead.
        const drop = buildMenu(item.items());
        drop.classList.add("floating");
        document.body.appendChild(drop);
        button.setAttribute("aria-expanded", "true");
        const at = button.getBoundingClientRect();
        const box = drop.getBoundingClientRect();
        drop.style.left = `${Math.max(8, Math.min(at.left, window.innerWidth - box.width - 8))}px`;
        drop.style.top = `${Math.min(at.bottom + 5, window.innerHeight - box.height - 8)}px`;
        openLayer([drop, button], () => {
          drop.remove();
          button.setAttribute("aria-expanded", "false");
        });
        menuKeys(drop);
      });
      return h("div", { class: "rib-anchor" }, [button]);
    }

    const command = this.registry.get(item.id);
    if (!command) return h("span");
    const button = this.button(command.icon ?? "command", item.label ?? command.label, size);
    button.title = [command.label, command.shortcut, command.hint]
      .filter(Boolean)
      .join(command.hint ? "  ·  " : "  ");
    // Local-tier commands stay clickable when the service is absent; the run
    // handler explains. Greying them is the signal, not disabling them.
    if (command.tier === "local") button.classList.add("local");
    button.addEventListener("click", () => {
      this.registry.run(item.id);
    });
    this.bound.push({ el: button, id: item.id });
    return button;
  }

  private button(name: string, label: string, size: RibbonSize, caret = false): HTMLButtonElement {
    const text = h("span", { class: "rib-label", text: label });
    // The caret rides on the label line so a large button stays two rows tall.
    if (caret) text.appendChild(icon("chevron", 10));
    return h("button", { class: `rib-btn ${size}`, type: "button" }, [icon(name, size === "lg" ? 17 : 13), text]);
  }
}
