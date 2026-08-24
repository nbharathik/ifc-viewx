// The definitions layer, on the inspector rail.
//
// Two halves of one idea. Views are the model state a coordinator set up,
// stored as rules so it re-runs on any revision. Properties are the derived
// data those rules read. Both export as a file somebody else can open.
import { confirmAction, h, icon, iconButton, promptForm, slidingPill, toast } from "./kit.js";
import { emptyState } from "./shell.js";
import type { ColorRule } from "./colorBy.js";
import { download } from "../sdk/data.js";
import type { PropertyIndex } from "../sdk/data.js";
import {
  COMPUTED_TEMPLATES,
  ComputedSet,
  ComputedStore,
  checkFormula,
  computedKey,
  parseComputedFile,
  serializeComputed,
  type ComputedKind,
  type ComputedProperty,
} from "../data/computed.js";
import {
  applySavedView,
  captureView,
  describeSelector,
  isPortable,
  parseViewFile,
  serializeViews,
  viewNeedsIndex,
  ViewStore,
  type ViewDefinition,
} from "../views/definition.js";
import type { Viewer } from "../viewer-core/viewer.js";

export interface ViewsActions {
  /** The colour rule in force, so a saved view carries it. */
  colorRule(): ColorRule | null;
  /** Put a colour rule back on the model after a view is applied. */
  setColorRule(rule: ColorRule | null): Promise<void> | void;
  /** Selectors for the visibility rules currently applied, by rule id. */
  selectors(): Map<string, unknown>;
  log(message: string, kind?: "info" | "success" | "error"): void;
  /** A view landed on screen; the status bar names it until it is cleared. */
  applied?(name: string): void;
  /** Attach the named view to a new BCF topic. */
  raiseIssue?(title: string, ids: number[]): void;
}

const THUMB_WIDTH = 240;

export class ViewsPane {
  private readonly gallery = h("div", { class: "views-gallery" });
  private readonly propsList = h("div", { class: "views-props" });
  private readonly viewsSection = h("div", { class: "page-sec" });
  private readonly propsSection = h("div", { class: "page-sec hidden" });
  private readonly counter = h("span", { class: "n" });
  private readonly search = h("input", {
    type: "search",
    placeholder: "Find a view",
    spellcheck: "false",
    "aria-label": "Find a saved view",
  });
  private readonly file = h("input", { type: "file", class: "hidden", accept: ".json,.ifcview,.ifcviews" });
  private readonly computed = new ComputedSet();
  private query = "";

  constructor(
    host: HTMLElement,
    private readonly viewer: Viewer,
    private readonly index: PropertyIndex,
    private readonly actions: ViewsActions,
    private readonly views = new ViewStore(),
    private readonly properties = new ComputedStore(),
  ) {
    this.search.addEventListener("input", () => {
      this.query = this.search.value.trim().toLowerCase();
      this.paintViews();
    });
    this.file.addEventListener("change", () => void this.importFile());

    const tabs = h("div", { class: "seg" });
    const viewsTab = h("button", { type: "button", text: "Views", "aria-pressed": "true" });
    const propsTab = h("button", { type: "button", text: "Properties", "aria-pressed": "false" });
    const show = (which: "views" | "props"): void => {
      viewsTab.setAttribute("aria-pressed", String(which === "views"));
      propsTab.setAttribute("aria-pressed", String(which === "props"));
      this.viewsSection.classList.toggle("hidden", which !== "views");
      this.propsSection.classList.toggle("hidden", which !== "props");
    };
    viewsTab.addEventListener("click", () => show("views"));
    propsTab.addEventListener("click", () => show("props"));
    tabs.append(viewsTab, propsTab);
    slidingPill(tabs);

    const save = h("button", { class: "btn accent grow", type: "button" }, [
      icon("bookmark", 13),
      h("span", { text: "Save this view" }),
    ]);
    save.addEventListener("click", () => void this.saveCurrent());

    this.viewsSection.append(
      h("div", { class: "row" }, [save]),
      h("div", { class: "row" }, [
        this.search,
        iconButton("download", "Export every view as a file", () => this.exportViews(), "icon-btn sm"),
        iconButton("folder", "Import views from a file", () => this.file.click(), "icon-btn sm"),
      ]),
      h("div", { class: "group-title" }, [h("span", { text: "Saved views" }), this.counter]),
      this.gallery,
      h("div", {
        class: "note",
        text: "A view stores rules, not element ids, so the same file applies to the next revision.",
      }),
    );

    const add = h("button", { class: "btn accent grow", type: "button" }, [
      icon("plus", 13),
      h("span", { text: "New property" }),
    ]);
    add.addEventListener("click", () => this.editProperty(null));
    const templates = h("button", { class: "btn", type: "button", text: "Templates" });
    templates.addEventListener("click", () => this.showTemplates());

    this.propsSection.append(
      h("div", { class: "row" }, [add, templates]),
      h("div", { class: "group-title" }, [
        h("span", { text: "Computed properties" }),
        h("span", { class: "row" }, [
          iconButton("download", "Export these definitions", () => this.exportProperties(), "icon-btn sm"),
          iconButton("folder", "Import definitions", () => this.file.click(), "icon-btn sm"),
        ]),
      ]),
      this.propsList,
      h("div", {
        class: "note",
        text: "Computed properties read like real ones: they filter, colour, group, schedule and report.",
      }),
    );

    host.appendChild(h("div", { class: "page scroll" }, [tabs, this.viewsSection, this.propsSection, this.file]));

    this.views.onChange(() => this.paintViews());
    this.properties.onChange(() => {
      this.syncComputed();
      this.paintProperties();
    });
    this.syncComputed();
    this.paintViews();
    this.paintProperties();
  }

  /** The computed set the rest of the app reads through the property index. */
  computedSet(): ComputedSet {
    return this.computed;
  }

  private syncComputed(): void {
    this.computed.set(this.properties.list());
    this.index.setComputed(this.computed.isEmpty() ? null : this.computed);
  }

  refresh(): void {
    this.paintViews();
    this.paintProperties();
  }

  // -- views ----------------------------------------------------------------

  async saveCurrent(): Promise<void> {
    if (!this.viewer.getStats()) return toast("Open a model first", "info");
    const thumbnail = await this.thumbnail();
    const folders = this.views.folders();
    promptForm(
      "Save view",
      [
        { key: "name", label: "Name", placeholder: "Fire compartmentation review" },
        { key: "folder", label: "Folder", placeholder: folders[0] ?? "Reviews", hint: folders.join(", ") },
        { key: "description", label: "What it shows", placeholder: "Optional" },
      ],
      "Save",
      (values) => {
        const name = values.name.trim();
        if (!name) return void toast("Name the view first", "info");
        const selectors = this.actions.selectors();
        const view = captureView(this.viewer, this.actions.colorRule(), {
          name,
          folder: values.folder.trim(),
          description: values.description.trim(),
          selectors: selectors as Map<string, never>,
          thumbnail,
        });
        if (!this.views.save(view)) return void toast("The browser could not store this view", "error");
        this.actions.log(`Saved view "${name}"`, "success");
        this.paintViews();
      },
    );
  }

  private async thumbnail(): Promise<string> {
    try {
      const blob = await this.viewer.captureImage(THUMB_WIDTH, "image/jpeg", 0.6);
      if (!blob) return "";
      return await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => resolve("");
        reader.readAsDataURL(blob);
      });
    } catch {
      return "";
    }
  }

  /** Apply a definition, building the property index first if a rule needs it. */
  async run(view: ViewDefinition): Promise<void> {
    if (!this.viewer.getStats()) return void toast("Open a model first", "info");
    if (viewNeedsIndex(view) && !this.index.ready()) {
      this.actions.log(`Reading properties for "${view.name}"`);
    }
    const report = await applySavedView(view, {
      viewer: this.viewer,
      index: this.index,
      setColorRule: (rule) => this.actions.setColorRule(rule),
    });
    this.actions.applied?.(view.name);
    if (report.empty.length) {
      this.actions.log(
        `"${view.name}" applied; ${report.empty.length} rule(s) matched nothing here: ${report.empty.join(", ")}`,
        "info",
      );
    } else {
      this.actions.log(`Applied view "${view.name}"`, "success");
    }
  }

  private paintViews(): void {
    const all = this.views.list();
    this.counter.textContent = all.length ? `${all.length}` : "";
    const list = this.query
      ? all.filter((view) =>
          `${view.name} ${view.folder} ${view.description}`.toLowerCase().includes(this.query))
      : all;
    if (list.length === 0) {
      this.gallery.replaceChildren(
        emptyState(
          "bookmark",
          all.length ? "Nothing matches that" : "No saved views yet",
          all.length ? "" : "Filter and colour the model the way you want it, then save it here.",
        ),
      );
      return;
    }
    const folders = new Map<string, ViewDefinition[]>();
    for (const view of list) {
      const key = view.folder || "Unfiled";
      const bucket = folders.get(key);
      if (bucket) bucket.push(view);
      else folders.set(key, [view]);
    }
    const nodes: HTMLElement[] = [];
    for (const [folder, views] of [...folders].sort((a, b) => a[0].localeCompare(b[0]))) {
      const body = h("div", { class: "views-grid" }, views.map((view) => this.card(view)));
      nodes.push(
        h("details", { class: "fold views-folder", open: "" }, [
          h("summary", {}, [h("span", { text: folder }), h("span", { class: "n", text: String(views.length) })]),
          body,
        ]),
      );
    }
    this.gallery.replaceChildren(...nodes);
  }

  private card(view: ViewDefinition): HTMLElement {
    const run = h("button", {
      class: "view-card",
      type: "button",
      title: view.description || `Apply "${view.name}"`,
    }, [
      view.thumbnail
        ? h("img", { class: "view-thumb", src: view.thumbnail, alt: "", loading: "lazy" })
        : h("div", { class: "view-thumb blank" }, [icon("bookmark", 18)]),
      h("div", { class: "view-meta" }, [
        h("span", { class: "view-name", text: view.name }),
        h("span", { class: "view-sub", text: this.summary(view) }),
      ]),
    ]);
    run.addEventListener("click", () => void this.run(view));

    const menu = iconButton("sliders", `Options for ${view.name}`, () => this.options(view), "icon-btn sm");
    return h("div", { class: "view-cell" }, [run, menu]);
  }

  private summary(view: ViewDefinition): string {
    const parts: string[] = [];
    if (view.filters.length) parts.push(`${view.filters.length} rule${view.filters.length === 1 ? "" : "s"}`);
    if (view.color && view.color.kind !== "none") parts.push(`colour by ${view.color.kind === "property" ? view.color.key : view.color.kind}`);
    if (view.sections.length) parts.push(`${view.sections.length} cut${view.sections.length === 1 ? "" : "s"}`);
    if (view.box) parts.push("box");
    if (view.annotations.length) parts.push(`${view.annotations.length} note${view.annotations.length === 1 ? "" : "s"}`);
    if (!isPortable(view)) parts.push("picked elements");
    return parts.join(" · ") || "camera only";
  }

  private options(view: ViewDefinition): void {
    const rules = view.filters.length
      ? h("div", { class: "pop-list" }, view.filters.map((filter) =>
          h("div", { class: "filter-row" }, [
            h("span", { class: "grow", text: filter.label, title: describeSelector(filter.selector) }),
            h("span", { class: "n", text: filter.mode === "hide" ? "hides" : "shows" }),
          ])))
      : h("div", { class: "note", text: "No visibility rules; this view is camera, cuts and colour." });

    const dialogBody = h("div", { class: "stack" }, [
      h("div", { class: "note", text: view.description || "No description." }),
      h("div", { class: "group-title", text: "Rules" }),
      rules,
      h("div", {
        class: isPortable(view) ? "note" : "note error",
        text: isPortable(view)
          ? "Every rule is written as a query, so this view applies to any revision."
          : "Some rules store picked element ids, which will not follow a revision. Rebuild them from a filter to make this portable.",
      }),
    ]);

    const dialog = h("dialog", { class: "form-dialog", "aria-label": `View ${view.name}` });
    const close = (): void => dialog.close();
    const act = (label: string, run: () => void, kind = "btn"): HTMLButtonElement => {
      const button = h("button", { class: kind, type: "button", text: label });
      button.addEventListener("click", () => {
        close();
        run();
      });
      return button;
    };
    dialog.append(
      h("div", { class: "dlg-head" }, [h("span", { text: view.name })]),
      h("div", { class: "dlg-body" }, [dialogBody]),
      h("div", { class: "dlg-foot" }, [
        act("Delete", () =>
          confirmAction(`Delete "${view.name}"?`, "The definition is removed from this browser.", "Delete", () => {
            this.views.remove(view.id);
            this.paintViews();
          }), "btn danger"),
        act("Rename", () =>
          promptForm(
            "Rename view",
            [
              { key: "name", label: "Name", value: view.name },
              { key: "folder", label: "Folder", value: view.folder },
            ],
            "Save",
            (values) => {
              this.views.rename(view.id, values.name.trim() || view.name, values.folder.trim());
              this.paintViews();
            },
          )),
        act("Update to current", () => void this.updateFrom(view)),
        act("Export", () => download(`${safeName(view.name)}.ifcview.json`, serializeViews([view]), "application/json")),
        act("Apply", () => void this.run(view), "btn primary"),
      ]),
    );
    dialog.addEventListener("close", () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
  }

  private async updateFrom(view: ViewDefinition): Promise<void> {
    const thumbnail = await this.thumbnail();
    const next = captureView(this.viewer, this.actions.colorRule(), {
      name: view.name,
      folder: view.folder,
      description: view.description,
      selectors: this.actions.selectors() as Map<string, never>,
      thumbnail: thumbnail || view.thumbnail,
    });
    next.id = view.id;
    this.views.save(next);
    this.actions.log(`Updated view "${view.name}"`, "success");
  }

  private exportViews(): void {
    const list = this.views.list();
    if (list.length === 0) return void toast("There is nothing to export yet", "info");
    download("views.ifcview.json", serializeViews(list), "application/json");
  }

  private exportProperties(): void {
    const list = this.properties.list();
    if (list.length === 0) return void toast("There is nothing to export yet", "info");
    download("properties.ifcprops.json", serializeComputed(list), "application/json");
  }

  /** One picker for both file kinds; the payload says which it is. */
  private async importFile(): Promise<void> {
    const file = this.file.files?.[0];
    this.file.value = "";
    if (!file) return;
    let text = "";
    try {
      text = await file.text();
    } catch {
      return void toast("That file could not be read", "error");
    }
    const views = safeParse(() => parseViewFile(text));
    if (views.length) {
      const added = this.views.merge(views);
      this.actions.log(`Imported ${added} view definition(s)`, "success");
      this.paintViews();
      return;
    }
    const properties = safeParse(() => parseComputedFile(text));
    if (properties.length) {
      const added = this.properties.merge(properties);
      this.actions.log(`Imported ${added} computed propert${added === 1 ? "y" : "ies"}`, "success");
      return;
    }
    toast("No views or properties were found in that file", "error");
  }

  // -- computed properties --------------------------------------------------

  private paintProperties(): void {
    const list = this.properties.list();
    if (list.length === 0) {
      this.propsList.replaceChildren(
        emptyState("sliders", "No computed properties", "Derive one value from the several the disciplines actually wrote."),
      );
      return;
    }
    this.propsList.replaceChildren(
      ...list.map((definition) => {
        const row = h("div", { class: "filter-row" }, [
          h("span", { class: "grow", text: definition.name, title: computedKey(definition.name) }),
          h("span", { class: "n", text: definition.kind }),
          iconButton("edit", `Edit ${definition.name}`, () => this.editProperty(definition), "icon-btn sm"),
          iconButton("trash", `Delete ${definition.name}`, () => {
            this.properties.remove(definition.id);
          }, "icon-btn sm"),
        ]);
        return row;
      }),
    );
  }

  private showTemplates(): void {
    const dialog = h("dialog", { class: "form-dialog", "aria-label": "Property templates" });
    const list = h("div", { class: "pop-list" });
    for (const template of COMPUTED_TEMPLATES) {
      const button = h("button", { class: "filter-row pick grow", type: "button", title: template.hint }, [
        h("span", { class: "grow", text: template.label }),
        icon("plus", 12),
      ]);
      button.addEventListener("click", () => {
        dialog.close();
        this.editProperty({ ...template.definition, id: `cp-${Math.random().toString(36).slice(2, 9)}` });
      });
      list.append(h("div", { class: "stack-tight" }, [button, h("div", { class: "note", text: template.hint })]));
    }
    const close = h("button", { class: "btn", type: "button", text: "Close" });
    close.addEventListener("click", () => dialog.close());
    dialog.append(
      h("div", { class: "dlg-head" }, [h("span", { text: "Start from a template" })]),
      h("div", { class: "dlg-body" }, [list]),
      h("div", { class: "dlg-foot" }, [close]),
    );
    dialog.addEventListener("close", () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
  }

  /** The editor. One dialog whose middle changes with the kind. */
  private editProperty(existing: ComputedProperty | null): void {
    const draft: ComputedProperty = existing
      ? { ...existing }
      : { id: `cp-${Math.random().toString(36).slice(2, 9)}`, name: "", kind: "coalesce", sources: [] };

    const dialog = h("dialog", { class: "form-dialog wide", "aria-label": "Computed property" });
    const name = h("input", { type: "text", value: draft.name, placeholder: "Fire rating" });
    const kind = h("select", {});
    const KINDS: Array<[ComputedKind, string]> = [
      ["coalesce", "First value that exists"],
      ["formula", "Formula"],
      ["concat", "Join values"],
      ["map", "Mapping table"],
      ["convert", "Unit conversion"],
      ["geometry", "Geometry quantity"],
      ["classification", "Classification lookup"],
    ];
    for (const [value, label] of KINDS) kind.append(h("option", { value, text: label }));
    kind.value = draft.kind;

    const body = h("div", { class: "stack" });
    const status = h("div", { class: "status-line" });

    const keyOptions = this.index.ready() ? this.index.propertyKeys().slice(0, 400).map(([key]) => key) : [];
    const keyList = h("datalist", { id: "computed-keys" }, keyOptions.map((key) => h("option", { value: key })));

    const textInput = (value: string, placeholder: string, onChange: (next: string) => void): HTMLInputElement => {
      const input = h("input", { type: "text", value, placeholder, list: "computed-keys" });
      input.addEventListener("input", () => onChange(input.value));
      return input;
    };

    const build = (): void => {
      const children: HTMLElement[] = [];
      if (draft.kind === "coalesce" || draft.kind === "concat") {
        const area = h("textarea", {
          rows: "4",
          placeholder: "One property per line, e.g. Pset_WallCommon.FireRating",
        });
        area.value = (draft.sources ?? []).join("\n");
        area.addEventListener("input", () => {
          draft.sources = area.value.split("\n").map((line) => line.trim()).filter(Boolean);
        });
        children.push(
          h("label", { class: "plug-field" }, [h("span", { text: "Sources, in order" }), area]),
        );
        if (draft.kind === "concat") {
          children.push(
            h("label", { class: "plug-field" }, [
              h("span", { text: "Separator" }),
              textInput(draft.separator ?? "-", "-", (value) => (draft.separator = value)),
            ]),
            h("div", { class: "note", text: "Wrap an entry in quotes to insert it literally." }),
          );
        }
      } else if (draft.kind === "formula") {
        const area = h("textarea", { rows: "4", placeholder: "COALESCE([NetArea], [Geometry.footprint])" });
        area.value = draft.expression ?? "";
        area.addEventListener("input", () => {
          draft.expression = area.value;
          const problem = checkFormula(area.value);
          status.textContent = problem ?? "";
          status.classList.toggle("error", problem !== null);
        });
        children.push(
          h("label", { class: "plug-field" }, [h("span", { text: "Formula" }), area]),
          h("div", {
            class: "note",
            text: "[Set.Property] or a bare [Property] reads the model. IF, COALESCE, ROUND, CONTAINS, UPPER, LEFT, SPLIT and & for text.",
          }),
        );
      } else if (draft.kind === "map") {
        const area = h("textarea", { rows: "5", placeholder: "FD30 = 30 minutes" });
        area.value = (draft.table ?? []).map(([from, to]) => `${from} = ${to}`).join("\n");
        area.addEventListener("input", () => {
          draft.table = area.value
            .split("\n")
            .map((line) => line.split("="))
            .filter((parts) => parts.length >= 2)
            .map((parts) => [parts[0].trim(), parts.slice(1).join("=").trim()] as [string, string]);
        });
        children.push(
          h("label", { class: "plug-field" }, [
            h("span", { text: "Source property" }),
            textInput(draft.source ?? "", "Pset_DoorCommon.FireRating", (value) => (draft.source = value)),
          ]),
          h("label", { class: "plug-field" }, [h("span", { text: "from = to, one per line" }), area]),
        );
      } else if (draft.kind === "convert") {
        children.push(
          h("label", { class: "plug-field" }, [
            h("span", { text: "Source property" }),
            textInput(draft.source ?? "", "Qto_WallBaseQuantities.NetVolume", (value) => (draft.source = value)),
          ]),
          h("label", { class: "plug-field" }, [
            h("span", { text: "Multiply by" }),
            textInput(String(draft.factor ?? 1), "0.001", (value) => (draft.factor = Number(value) || 0)),
          ]),
          h("label", { class: "plug-field" }, [
            h("span", { text: "Then add" }),
            textInput(String(draft.offset ?? 0), "0", (value) => (draft.offset = Number(value) || 0)),
          ]),
        );
      } else if (draft.kind === "geometry") {
        const measure = h("select", {});
        for (const [value, label] of [
          ["boxVolume", "Bounding volume"],
          ["boxArea", "Bounding surface area"],
          ["footprint", "Footprint area"],
          ["height", "Height"],
          ["width", "Longest side"],
          ["depth", "Shortest side"],
        ] as Array<[string, string]>) {
          measure.append(h("option", { value, text: label }));
        }
        measure.value = draft.measure ?? "boxVolume";
        measure.addEventListener("change", () => (draft.measure = measure.value as ComputedProperty["measure"]));
        children.push(h("label", { class: "plug-field" }, [h("span", { text: "Measure" }), measure]));
      } else {
        children.push(
          h("label", { class: "plug-field" }, [
            h("span", { text: "Preferred system" }),
            textInput(draft.system ?? "", "Uniclass", (value) => (draft.system = value)),
          ]),
        );
      }
      if (draft.kind !== "geometry") {
        children.push(
          h("label", { class: "plug-field" }, [
            h("span", { text: "When nothing matches" }),
            textInput(draft.fallback ?? "", "Leave blank", (value) => (draft.fallback = value)),
          ]),
        );
      }
      body.replaceChildren(...children);
    };

    kind.addEventListener("change", () => {
      draft.kind = kind.value as ComputedKind;
      build();
    });
    name.addEventListener("input", () => (draft.name = name.value));
    build();

    const preview = h("div", { class: "note" });
    const previewButton = h("button", { class: "btn", type: "button", text: "Preview" });
    previewButton.addEventListener("click", () => {
      const rows = this.index.all();
      if (rows.length === 0) {
        preview.textContent = "Build the property index first: open any data panel, or apply a property filter.";
        return;
      }
      const set = new ComputedSet([{ ...draft, name: draft.name || "Preview" }]);
      const key = computedKey(draft.name || "Preview");
      const samples: string[] = [];
      let filled = 0;
      for (const row of rows) {
        const value = set.evaluate(row, {
          geometry: (id) => {
            const bounds = this.viewer.getElementBounds(id);
            return bounds
              ? { min: [bounds.min.x, bounds.min.y, bounds.min.z], max: [bounds.max.x, bounds.max.y, bounds.max.z] }
              : null;
          },
        })[key];
        if (value !== null && value !== undefined && value !== "") {
          filled++;
          if (samples.length < 4) samples.push(`${row.type.replace(/^Ifc/, "")}: ${String(value)}`);
        }
      }
      preview.textContent = `${filled.toLocaleString()} of ${rows.length.toLocaleString()} elements get a value. ${samples.join(" | ")}`;
    });

    const cancel = h("button", { class: "btn", type: "button", text: "Cancel" });
    cancel.addEventListener("click", () => dialog.close());
    const save = h("button", { class: "btn primary", type: "button", text: "Save" });
    save.addEventListener("click", () => {
      if (!draft.name.trim()) return void toast("Name the property first", "info");
      if (draft.kind === "formula") {
        const problem = checkFormula(draft.expression ?? "");
        if (problem) return void toast(problem, "error");
      }
      if (!this.properties.save({ ...draft, name: draft.name.trim() })) {
        return void toast("That computed-property definition is invalid or the 256-definition limit was reached", "error");
      }
      this.actions.log(`Computed property "${draft.name.trim()}" saved`, "success");
      dialog.close();
    });

    dialog.append(
      h("div", { class: "dlg-head" }, [h("span", { text: existing ? "Edit property" : "New computed property" })]),
      h("div", { class: "dlg-body" }, [
        keyList,
        h("label", { class: "plug-field" }, [h("span", { text: "Name" }), name]),
        h("label", { class: "plug-field" }, [h("span", { text: "How it is derived" }), kind]),
        body,
        status,
        h("div", { class: "row" }, [previewButton, preview]),
      ]),
      h("div", { class: "dlg-foot" }, [cancel, save]),
    );
    dialog.addEventListener("close", () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();
    name.focus();
  }
}

const safeName = (name: string): string => name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "view";

function safeParse<T>(run: () => T[]): T[] {
  try {
    return run();
  } catch {
    return [];
  }
}
