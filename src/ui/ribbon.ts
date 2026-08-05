// The ribbon: a tab strip in the top bar and one slim strip of grouped
// commands under it. Tabs are data; every button points at a command id, so
// the ribbon holds no app state of its own.
//
// Collapsed, the strip takes no height and a tab click opens it as a flyout
// that closes after one command (the PowerPoint behaviour, at a lighter
// weight). The choice persists.
import { buildMenu, closeLayer, h, icon, openLayer, type MenuItem } from "./kit.js";
import type { CommandRegistry } from "./commands.js";

export interface RibbonControl {
  el: HTMLElement;
  /** Called on every ribbon sync while the control is on screen. */
  sync?: () => void;
}

export type RibbonItem =
  | { kind: "cmd"; id: string; size?: "lg" | "sm"; label?: string }
  | { kind: "menu"; label: string; icon: string; size?: "lg" | "sm"; items: () => MenuItem[] }
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
  private collapsed = localStorage.getItem(COLLAPSE_KEY) === "1";
  private flyout = false;

  constructor(
    tabHost: HTMLElement,
    private readonly body: HTMLElement,
    private readonly registry: CommandRegistry,
    private readonly tabs: RibbonTab[],
  ) {
    this.strip = h("div", { class: "rib-strip" });
    this.body.appendChild(this.strip);

    for (const tab of tabs) {
      const button = h("button", {
        class: "rib-tab",
        type: "button",
        role: "tab",
        text: tab.label,
        "aria-selected": "false",
      });
      button.addEventListener("click", () => this.onTabClick(tab.id));
      button.addEventListener("dblclick", () => this.setCollapsed(!this.collapsed));
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

    const stored = localStorage.getItem(TAB_KEY);
    this.active = tabs.some((t) => t.id === stored) ? stored! : tabs[0].id;
    this.render();
    this.paintCollapsed();
  }

  /** Show a tab; opens the flyout instead when the ribbon is collapsed. */
  select(id: string, viaTab = false): void {
    if (this.active !== id) {
      this.active = id;
      localStorage.setItem(TAB_KEY, id);
      this.render();
    }
    if (this.collapsed && viaTab) this.openFlyout();
  }

  getTab(): string {
    return this.active;
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    if (collapsed) closeLayer();
    this.flyout = false;
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
    if (this.collapsed && this.active === id && this.flyout) return closeLayer();
    this.select(id, true);
  }

  private paintCollapsed(): void {
    this.body.classList.toggle("collapsed", this.collapsed && !this.flyout);
    this.body.classList.toggle("flyout", this.flyout);
    this.toggleBtn.classList.toggle("up", this.collapsed);
    this.toggleBtn.title = this.collapsed ? "Pin the ribbon  Ctrl+F1" : "Collapse the ribbon  Ctrl+F1";
  }

  private openFlyout(): void {
    // Drop any open layer first: openLayer would otherwise run the previous
    // flyout's close handler *after* we set the new state and undo it.
    closeLayer();
    this.flyout = true;
    this.paintCollapsed();
    openLayer([this.body, ...this.tabButtons.values()], () => {
      this.flyout = false;
      this.paintCollapsed();
    });
  }

  private render(): void {
    const tab = this.tabs.find((t) => t.id === this.active) ?? this.tabs[0];
    for (const [id, button] of this.tabButtons) {
      const on = id === tab.id;
      button.classList.toggle("active", on);
      button.setAttribute("aria-selected", String(on));
    }
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
      const large = item.kind === "control" || item.size !== "sm";
      if (large) {
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

  private buildItem(item: RibbonItem, size: "lg" | "sm"): HTMLElement {
    if (item.kind === "control") {
      const control = item.build();
      this.controls.push(control);
      return control.el;
    }
    if (item.kind === "menu") {
      const button = this.button(item.icon, item.label, size, true);
      button.addEventListener("click", () => {
        if (button.getAttribute("aria-expanded") === "true") return closeLayer();
        // A dropdown claims the transient layer, which would dismiss the
        // flyout it sits in; pin the ribbon instead of vanishing under it.
        if (this.flyout) this.setCollapsed(false);
        const drop = buildMenu(item.items());
        button.parentElement?.appendChild(drop);
        button.setAttribute("aria-expanded", "true");
        // Keep it on screen when the anchor sits near the right edge.
        const rect = drop.getBoundingClientRect();
        const overflow = rect.right - (window.innerWidth - 8);
        if (overflow > 0) drop.style.marginLeft = `${-overflow}px`;
        openLayer([drop, button], () => {
          drop.remove();
          button.setAttribute("aria-expanded", "false");
        });
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
      if (this.flyout) closeLayer();
      this.registry.run(item.id);
    });
    this.bound.push({ el: button, id: item.id });
    return button;
  }

  private button(name: string, label: string, size: "lg" | "sm", caret = false): HTMLButtonElement {
    const text = h("span", { class: "rib-label", text: label });
    // The caret rides on the label line so a large button stays two rows tall.
    if (caret) text.appendChild(icon("chevron", 10));
    return h("button", { class: `rib-btn ${size}`, type: "button" }, [icon(name, size === "lg" ? 19 : 14), text]);
  }
}
