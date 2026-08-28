// Sheets: the drawing that was issued, beside the model that produced it.
//
// The page is a raster; everything drawn over it is SVG in sheet-pixel space,
// so the overlay, the markup and the measurements all survive pan and zoom
// without being re-rendered. Sheet pixels become model metres through one
// similarity, which is the only piece of arithmetic in here.
import {
  bar,
  button,
  h,
  header,
  hint,
  icon,
  isPdf,
  measureOnSheet,
  metresPerPixel,
  newSheet,
  note,
  page as pageRoot,
  placementDrift,
  progress,
  promptForm,
  readImagePage,
  renderPdfPages,
  scaleLabel,
  select,
  sheetStore,
  sheetToWorld,
  toast,
  worldToSheet,
  type ExtensionContext,
  type ExtensionInstance,
  type SheetMarkup,
  type SheetPoint,
  type StoredSheet,
} from "@ifcviewx/sdk";

type Tool = "pan" | "calibrate" | "align" | "measure" | "markup" | "pick";

const TOOLS: Array<[string, string]> = [
  ["pan", "Pan and zoom"],
  ["pick", "Click to select in 3D"],
  ["measure", "Measure"],
  ["markup", "Mark up"],
  ["calibrate", "Set the scale"],
  ["align", "Place on the model"],
];

const MARKUP_KINDS: Array<[string, string]> = [
  ["line", "Line"],
  ["arrow", "Arrow"],
  ["rect", "Box"],
  ["cloud", "Cloud"],
  ["text", "Note"],
];

const SVG_NS = "http://www.w3.org/2000/svg";

interface Pending {
  points: SheetPoint[];
}

export function mount(host: HTMLElement, ctx: ExtensionContext): ExtensionInstance {
  let sheets: StoredSheet[] = [];
  let active: StoredSheet | null = null;
  let imageUrl = "";
  let tool: Tool = ctx.storage.read<Tool>("tool", "pan");
  let markupKind = ctx.storage.read<string>("markupKind", "cloud");
  let pending: Pending = { points: [] };
  let overlayOn = ctx.storage.read<boolean>("overlay", true);
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let dragging: { x: number; y: number; panX: number; panY: number } | null = null;
  let measured: { a: SheetPoint; b: SheetPoint; metres: number } | null = null;
  let importController: AbortController | null = null;
  let importGeneration = 0;
  let reloadGeneration = 0;
  let overlayController: AbortController | null = null;
  let overlayGeneration = 0;

  const importStatus = progress();
  const overlayStatus = progress();
  const reportError = (error: unknown): void => {
    if (error instanceof DOMException && error.name === "AbortError") return;
    ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
  };
  const launch = (operation: Promise<unknown>): void => void operation.catch(reportError);
  const currentModelKey = (): string => ctx.session.model().key;
  const list = h("div", { class: "sheet-list" });
  const stage = h("div", { class: "sheet-stage", tabindex: "0" });
  const image = h("img", { class: "sheet-image", alt: "" });
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "sheet-svg");
  const overlayLayer = document.createElementNS(SVG_NS, "g");
  overlayLayer.setAttribute("class", "sheet-overlay");
  const annotationLayer = document.createElementNS(SVG_NS, "g");
  annotationLayer.setAttribute("class", "sheet-annotations");
  svg.append(overlayLayer, annotationLayer);
  const canvas = h("div", { class: "sheet-canvas" });
  canvas.append(image, svg as unknown as Node);
  stage.appendChild(canvas);
  const info = h("div", { class: "sheet-info" });
  const file = h("input", { type: "file", class: "hidden", accept: ".pdf,.png,.jpg,.jpeg,.webp" });

  // -- import ---------------------------------------------------------------

  const importFile = async (chosen: File): Promise<void> => {
    importController?.abort();
    const controller = new AbortController();
    importController = controller;
    const generation = ++importGeneration;
    const scopeKey = currentModelKey();
    const importedIds: string[] = [];
    const onClose = (): void => controller.abort();
    ctx.signal.addEventListener("abort", onClose, { once: true });
    if (ctx.signal.aborted) controller.abort();
    importStatus.set(0, 1, `Reading ${chosen.name}`);
    try {
      if (chosen.type === "image/svg+xml" || chosen.name.toLowerCase().endsWith(".svg")) {
        throw new Error("SVG sheets are not imported because they can reference remote content. Export the drawing as PDF or PNG first.");
      }
      const sizeLimit = isPdf(chosen.name, chosen.type) ? 256 * 1024 * 1024 : 64 * 1024 * 1024;
      if (chosen.size > sizeLimit) {
        throw new Error(`That ${isPdf(chosen.name, chosen.type) ? "PDF" : "image"} is too large to import safely in this tab.`);
      }
      const baseName = chosen.name.replace(/\.[^.]+$/, "");
      let firstId = "";
      let pageCount = 1;
      let imported = 0;
      if (isPdf(chosen.name, chosen.type)) {
        const data = await chosen.arrayBuffer();
        if (controller.signal.aborted) throw new DOMException("Sheet import cancelled", "AbortError");
        const result = await renderPdfPages(
          data,
          async (rendered) => {
            if (controller.signal.aborted) throw new DOMException("Sheet import cancelled", "AbortError");
            const sheet = newSheet(
              rendered.page === 1 ? baseName : `${baseName} p${rendered.page}`,
              chosen.name,
              rendered,
              scopeKey,
            );
            await sheetStore.put(sheet);
            importedIds.push(sheet.id);
            firstId ||= sheet.id;
          },
          {
            maxPages: 40,
            signal: controller.signal,
            onProgress: (pageNumber, total) => {
              if (generation === importGeneration) {
                importStatus.set(pageNumber - 1, total, `Rasterizing page ${pageNumber} of ${total}`);
              }
            },
          },
        );
        pageCount = result.pageCount;
        imported = result.rendered;
      } else {
        const rendered = await readImagePage(chosen, controller.signal);
        const sheet = newSheet(baseName, chosen.name, rendered, scopeKey);
        await sheetStore.put(sheet);
        importedIds.push(sheet.id);
        firstId = sheet.id;
        imported = 1;
      }
      if (controller.signal.aborted || scopeKey !== currentModelKey()) {
        throw new DOMException("Sheet import cancelled", "AbortError");
      }
      await reload(firstId);
      ctx.feedback.log(
        pageCount > imported
          ? `Imported the first ${imported} of ${pageCount} sheet pages from ${chosen.name}`
          : `Imported ${imported} sheet page(s) from ${chosen.name}`,
        "success",
      );
    } catch (error) {
      if (importedIds.length > 0) {
        const rolledBack = await Promise.allSettled(importedIds.map((id) => sheetStore.remove(id)));
        if (rolledBack.some((result) => result.status === "rejected")) {
          ctx.feedback.log("The incomplete sheet import could not be fully rolled back", "error");
        }
      }
      reportError(error);
      // A model change may race the rollback's IndexedDB transactions. Reload
      // once they finish so no page removed from storage remains visible.
      if (!ctx.signal.aborted && controller.signal.aborted) await reload().catch(reportError);
    } finally {
      ctx.signal.removeEventListener("abort", onClose);
      if (importController === controller) importController = null;
      if (generation === importGeneration) importStatus.hide();
    }
  };

  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    file.value = "";
    if (chosen) void importFile(chosen);
  });

  const reload = async (selectId?: string): Promise<void> => {
    const generation = ++reloadGeneration;
    const scopeKey = currentModelKey();
    const stored = await sheetStore.all();
    if (generation !== reloadGeneration || ctx.signal.aborted || scopeKey !== currentModelKey()) return;

    // Records created before model scoping are adopted once. Their placement
    // cannot be trusted against an arbitrary currently-open model, so only the
    // raster, calibration and markups migrate.
    if (scopeKey) {
      for (const sheet of stored) {
        if (sheet.modelKey) continue;
        sheet.modelKey = scopeKey;
        sheet.placement = null;
        await sheetStore.put(sheet);
        if (generation !== reloadGeneration || ctx.signal.aborted || scopeKey !== currentModelKey()) return;
      }
    }

    const previous = active?.id;
    sheets = stored.filter((sheet) => scopeKey ? sheet.modelKey === scopeKey : !sheet.modelKey);
    const wanted = selectId ?? previous ?? sheets[0]?.id;
    active = sheets.find((sheet) => sheet.id === wanted) ?? sheets[0] ?? null;
    if (active?.id !== previous) {
      measured = null;
      pending = { points: [] };
    }
    paintList();
    await showActive();
  };

  const save = async (): Promise<void> => {
    if (!active) return;
    await sheetStore.put(active);
    paintList();
    paintInfo();
  };

  // -- stage ----------------------------------------------------------------

  const showActive = async (): Promise<void> => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = "";
    if (!active) {
      image.removeAttribute("src");
      invalidateOverlay();
      paintPending();
      paintInfo();
      return;
    }
    imageUrl = URL.createObjectURL(active.image);
    image.src = imageUrl;
    canvas.style.width = `${active.width}px`;
    canvas.style.height = `${active.height}px`;
    svg.setAttribute("viewBox", `0 0 ${active.width} ${active.height}`);
    svg.setAttribute("width", String(active.width));
    svg.setAttribute("height", String(active.height));
    fit();
    paintInfo();
    void paintOverlay();
  };

  const fit = (): void => {
    if (!active) return;
    const box = stage.getBoundingClientRect();
    if (box.width < 10 || box.height < 10) {
      zoom = 1;
    } else {
      zoom = Math.min(box.width / active.width, box.height / active.height) * 0.96;
    }
    panX = (box.width - active.width * zoom) / 2;
    panY = (box.height - active.height * zoom) / 2;
    applyTransform();
  };

  const applyTransform = (): void => {
    canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  };

  /** Sheet-pixel coordinates of a pointer event over the stage. */
  const pointOf = (event: PointerEvent | MouseEvent): SheetPoint => {
    const box = stage.getBoundingClientRect();
    return {
      x: (event.clientX - box.left - panX) / zoom,
      y: (event.clientY - box.top - panY) / zoom,
    };
  };

  stage.addEventListener("wheel", (event) => {
    event.preventDefault();
    const before = pointOf(event);
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoom = Math.min(12, Math.max(0.05, zoom * factor));
    const box = stage.getBoundingClientRect();
    panX = event.clientX - box.left - before.x * zoom;
    panY = event.clientY - box.top - before.y * zoom;
    applyTransform();
  }, { passive: false });

  stage.addEventListener("pointerdown", (event) => {
    if (!active) return;
    stage.setPointerCapture(event.pointerId);
    if (tool === "pan" || event.button === 1 || event.shiftKey) {
      dragging = { x: event.clientX, y: event.clientY, panX, panY };
      return;
    }
    launch(handleClick(pointOf(event)));
  });

  stage.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    panX = dragging.panX + (event.clientX - dragging.x);
    panY = dragging.panY + (event.clientY - dragging.y);
    applyTransform();
  });

  stage.addEventListener("pointerup", () => {
    dragging = null;
  });

  // -- tools ----------------------------------------------------------------

  const handleClick = async (point: SheetPoint): Promise<void> => {
    if (!active) return;
    if (tool === "pick") return pickThrough(point);
    if (tool === "calibrate") {
      pending.points.push(point);
      if (pending.points.length < 2) {
        paintPending();
        return;
      }
      const [a, b] = pending.points;
      pending = { points: [] };
      promptForm(
        "Set the scale",
        [{ key: "distance", label: "Real distance between those two points (m)", placeholder: "5.0" }],
        "Calibrate",
        (values) => {
          const distance = Number(values.distance);
          if (!Number.isFinite(distance) || distance <= 0) return void toast("Give a distance in metres", "error");
          if (!active) return;
          active.calibration = { a, b, distance };
          launch(save());
          paintPending();
          ctx.feedback.log(`${active.name} calibrated at ${scaleLabel(active)}`, "success");
        },
      );
      return;
    }
    if (tool === "align") {
      const pick = ctx.view.lastPick();
      if (!pick) {
        toast("Click the matching point in the 3D view first, then click it here", "info");
        return;
      }
      pending.points.push(point);
      const world: [number, number] = [pick.point[0], pick.point[2]];
      if (pending.points.length === 1) {
        active.placement = {
          sheetA: point,
          sheetB: point,
          worldA: world,
          worldB: world,
          flip: active.placement?.flip ?? false,
        };
        toast("First point paired. Pick a second, well separated point in 3D, then here.", "info");
        paintPending();
        return;
      }
      if (active.placement) {
        active.placement.sheetB = point;
        active.placement.worldB = world;
      }
      pending = { points: [] };
      await save();
      void paintOverlay();
      const drift = placementDrift(active);
      ctx.feedback.log(
        drift !== null && drift > 0.05
          ? `${active.name} placed, but the placement disagrees with the calibration by ${Math.round(drift * 100)}%. Check the pairs.`
          : `${active.name} placed on the model`,
        drift !== null && drift > 0.05 ? "error" : "success",
      );
      return;
    }
    if (tool === "measure") {
      pending.points.push(point);
      if (pending.points.length < 2) {
        paintPending();
        return;
      }
      const [a, b] = pending.points;
      pending = { points: [] };
      const metres = measureOnSheet(active, a, b);
      if (metres === null) {
        toast("Calibrate the sheet first", "info");
        return;
      }
      measured = { a, b, metres };
      paintPending();
      return;
    }
    if (tool === "markup") {
      pending.points.push(point);
      const needed = markupKind === "text" ? 1 : 2;
      if (pending.points.length < needed) {
        paintPending();
        return;
      }
      const points = pending.points.slice(0, needed);
      pending = { points: [] };
      if (markupKind === "text") {
        promptForm("Note", [{ key: "text", label: "Text" }], "Add", (values) => {
          if (!values.text.trim() || !active) return;
          addMarkup({ kind: "text", points, text: values.text.trim() });
        });
        return;
      }
      addMarkup({ kind: markupKind as SheetMarkup["kind"], points });
    }
  };

  const addMarkup = (markup: Omit<SheetMarkup, "id" | "createdAt">): void => {
    if (!active) return;
    active.markups.push({
      ...markup,
      id: `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: new Date().toISOString(),
    });
    launch(save());
    paintPending();
  };

  /**
   * A click on the sheet, answered in 3D. The sheet point becomes a plan
   * coordinate, and the smallest element whose footprint covers it wins:
   * picking the largest would always return the slab.
   */
  const pickThrough = (point: SheetPoint): void => {
    if (!active) return;
    const world = sheetToWorld(active, point);
    if (!world) {
      toast("Place the sheet on the model first", "info");
      return;
    }
    const band = cutBand();
    let best: { id: number; area: number } | null = null;
    for (const element of ctx.model.elements()) {
      const bounds = ctx.model.bounds(element.id);
      if (!bounds) continue;
      if (world[0] < bounds.min.x || world[0] > bounds.max.x) continue;
      if (world[1] < bounds.min.z || world[1] > bounds.max.z) continue;
      if (band !== null && (bounds.max.y < band[0] || bounds.min.y > band[1])) continue;
      const area = Math.max(1e-6, (bounds.max.x - bounds.min.x) * (bounds.max.z - bounds.min.z));
      if (!best || area < best.area) best = { id: element.id, area };
    }
    if (!best) {
      toast("Nothing in the model under that point", "info");
      return;
    }
    ctx.view.select(best.id);
    ctx.view.frame(best.id);
    ctx.feedback.log(`Selected ${best.id} from ${active.name}`);
  };

  /** The vertical band this sheet draws, from its storey or its cut height. */
  const cutBand = (): [number, number] | null => {
    if (!active) return null;
    if (active.cutHeight !== null) return [active.cutHeight - 1.6, active.cutHeight + 1.6];
    if (!active.storey) return null;
    const heights = ctx.model
      .elements()
      .filter((element) => element.storey === active?.storey)
      .map((element) => ctx.model.bounds(element.id))
      .filter((bounds): bounds is NonNullable<typeof bounds> => bounds !== null);
    if (heights.length === 0) return null;
    return [
      Math.min(...heights.map((bounds) => bounds.min.y)),
      Math.max(...heights.map((bounds) => bounds.max.y)),
    ];
  };

  // -- overlay --------------------------------------------------------------

  const invalidateOverlay = (): void => {
    overlayGeneration++;
    overlayController?.abort();
    overlayController = null;
    overlayLayer.replaceChildren();
  };

  const paintOverlay = async (): Promise<void> => {
    invalidateOverlay();
    paintPending();
    const sheet = active;
    if (!sheet || !overlayOn || !sheet.placement) {
      overlayStatus.hide();
      return;
    }
    const band = cutBand();
    const offset = sheet.cutHeight ?? (band ? band[0] + Math.min(1.2, (band[1] - band[0]) / 2) : null);
    if (offset === null) {
      overlayStatus.hide();
      return;
    }
    const generation = overlayGeneration;
    const scopeKey = currentModelKey();
    const controller = new AbortController();
    overlayController = controller;
    try {
      overlayStatus.set(0, 1, "Cutting the model at this sheet's level");
      const contours = await ctx.geometry.sectionContours("y", offset, {
        maxSegments: 2500,
        signal: controller.signal,
      });
      if (
        generation !== overlayGeneration
        || controller.signal.aborted
        || ctx.signal.aborted
        || active !== sheet
        || currentModelKey() !== scopeKey
        || !overlayOn
      ) return;
      const group = document.createElementNS(SVG_NS, "g");
      for (const line of contours.polylines) {
        const points: string[] = [];
        for (const [worldX, worldZ] of line.points) {
          const at = worldToSheet(sheet, [worldX, worldZ]);
          if (!at) continue;
          points.push(`${at.x.toFixed(1)},${at.y.toFixed(1)}`);
        }
        if (points.length < 2) continue;
        const element = document.createElementNS(SVG_NS, line.closed ? "polygon" : "polyline");
        element.setAttribute("points", points.join(" "));
        group.appendChild(element);
      }
      overlayLayer.replaceChildren(group);
      ctx.feedback.log(`Overlaid ${contours.polylines.length.toLocaleString()} model paths on ${sheet.name}`);
    } catch (error) {
      if (
        generation === overlayGeneration
        && !controller.signal.aborted
        && (!(error instanceof DOMException) || error.name !== "AbortError")
      ) reportError(error);
    } finally {
      if (generation === overlayGeneration && overlayController === controller) {
        overlayController = null;
        overlayStatus.hide();
      }
    }
  };

  /** Markups, the measurement in hand and the points picked so far. */
  const paintPending = (): void => {
    annotationLayer.replaceChildren();
    if (!active) return;
    for (const markup of active.markups) annotationLayer.appendChild(drawMarkup(markup));
    if (measured) {
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", String(measured.a.x));
      line.setAttribute("y1", String(measured.a.y));
      line.setAttribute("x2", String(measured.b.x));
      line.setAttribute("y2", String(measured.b.y));
      line.setAttribute("class", "sheet-measure");
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", String((measured.a.x + measured.b.x) / 2));
      text.setAttribute("y", String((measured.a.y + measured.b.y) / 2 - 8));
      text.setAttribute("class", "sheet-measure-label");
      text.textContent = `${measured.metres.toFixed(3)} m`;
      annotationLayer.append(line, text);
    }
    for (const point of pending.points) {
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", String(point.x));
      dot.setAttribute("cy", String(point.y));
      dot.setAttribute("r", "6");
      dot.setAttribute("class", "sheet-pending");
      annotationLayer.appendChild(dot);
    }
  };

  const drawMarkup = (markup: SheetMarkup): SVGElement => {
    const [a, b] = markup.points;
    if (markup.kind === "text") {
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", String(a.x));
      text.setAttribute("y", String(a.y));
      text.setAttribute("class", "sheet-markup-text");
      text.textContent = markup.text ?? "";
      return text;
    }
    if (markup.kind === "rect" || markup.kind === "cloud") {
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", String(Math.min(a.x, b.x)));
      rect.setAttribute("y", String(Math.min(a.y, b.y)));
      rect.setAttribute("width", String(Math.abs(b.x - a.x)));
      rect.setAttribute("height", String(Math.abs(b.y - a.y)));
      rect.setAttribute("class", markup.kind === "cloud" ? "sheet-markup-cloud" : "sheet-markup-rect");
      return rect;
    }
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(a.x));
    line.setAttribute("y1", String(a.y));
    line.setAttribute("x2", String(b.x));
    line.setAttribute("y2", String(b.y));
    line.setAttribute("class", markup.kind === "arrow" ? "sheet-markup-arrow" : "sheet-markup-line");
    return line;
  };

  // -- issues ---------------------------------------------------------------

  /**
   * A markup becomes a BCF topic. The 3D view is moved to the same place
   * first, so the snapshot the issue carries shows the model at the spot the
   * drawing was marked rather than wherever the camera happened to be.
   */
  const raiseFromMarkup = async (markup: SheetMarkup): Promise<void> => {
    if (!active) return;
    const centre = {
      x: markup.points.reduce((sum, point) => sum + point.x, 0) / markup.points.length,
      y: markup.points.reduce((sum, point) => sum + point.y, 0) / markup.points.length,
    };
    const world = sheetToWorld(active, centre);
    const band = cutBand();
    const height = active.cutHeight ?? (band ? (band[0] + band[1]) / 2 : 0);
    const ids: number[] = [];
    if (world) {
      for (const element of ctx.model.elements()) {
        const bounds = ctx.model.bounds(element.id);
        if (!bounds) continue;
        if (world[0] < bounds.min.x || world[0] > bounds.max.x) continue;
        if (world[1] < bounds.min.z || world[1] > bounds.max.z) continue;
        if (band && (bounds.max.y < band[0] || bounds.min.y > band[1])) continue;
        ids.push(element.id);
      }
    }
    const point: [number, number, number] | undefined = world ? [world[0], height, world[1]] : undefined;
    if (point) ctx.view.frameAt(point, 6);
    await ctx.issues.create({
      title: markup.text?.trim() || `Markup on ${active.name}`,
      description: [
        `Raised from sheet ${active.name}`,
        active.storey ? `Storey: ${active.storey}` : "",
        `Scale: ${scaleLabel(active)}`,
        world ? `Plan coordinate: ${world[0].toFixed(3)}, ${world[1].toFixed(3)}` : "This sheet is not placed on the model.",
      ].filter(Boolean).join("\n"),
      elementIds: ids.slice(0, 100),
      point,
    });
    ctx.feedback.log(`Raised an issue from ${active.name}`, "success");
  };

  // -- chrome ---------------------------------------------------------------

  const paintList = (): void => {
    if (sheets.length === 0) {
      list.replaceChildren(note("No sheets yet. Import the PDF that was issued."));
      return;
    }
    list.replaceChildren(
      ...sheets.map((sheet) => {
        const row = h("button", {
          class: `sheet-row${sheet.id === active?.id ? " active" : ""}`,
          type: "button",
          title: `${sheet.name} · ${scaleLabel(sheet)}`,
        }, [
          icon("layers", 12),
          h("span", { class: "grow", text: sheet.name }),
          h("span", { class: "n", text: sheet.calibration ? scaleLabel(sheet) : "uncalibrated" }),
        ]);
        row.addEventListener("click", () => {
          active = sheet;
          measured = null;
          pending = { points: [] };
          paintList();
          launch(showActive());
        });
        return row;
      }),
    );
  };

  const paintInfo = (): void => {
    if (!active) {
      info.replaceChildren();
      return;
    }
    const perPixel = metresPerPixel(active);
    const drift = placementDrift(active);
    const storeys = [...new Set(ctx.model.elements().map((element) => element.storey).filter(Boolean))];
    const storeyPick = select(
      [["", "No storey"], ...storeys.map((name) => [name, name] as [string, string])],
      active.storey,
      (value) => {
        if (!active) return;
        active.storey = value;
        launch(save().then(() => paintOverlay()));
      },
    );
    const rename = button("Rename", () => {
      promptForm("Sheet name", [{ key: "name", label: "Name", value: active?.name ?? "" }], "Save", (values) => {
        if (!active || !values.name.trim()) return;
        active.name = values.name.trim();
        launch(save());
      });
    });
    const remove = button("Delete", () => {
      if (!active) return;
      const id = active.id;
      launch(sheetStore.remove(id).then(() => reload()));
    });
    const flip = button(active.placement?.flip ? "Unmirror" : "Mirror", () => {
      if (!active?.placement) return void toast("Place the sheet first", "info");
      active.placement.flip = !active.placement.flip;
      launch(save().then(() => paintOverlay()));
    });
    info.replaceChildren(
      h("div", { class: "sheet-facts" }, [
        h("span", {}, [h("b", { text: scaleLabel(active) }), h("small", { text: "scale" })]),
        h("span", {}, [h("b", { text: perPixel ? `${(perPixel * 1000).toFixed(2)} mm` : "-" }), h("small", { text: "per pixel" })]),
        h("span", {}, [h("b", { text: active.placement ? "placed" : "not placed" }), h("small", { text: "on the model" })]),
        h("span", {}, [h("b", { text: `${active.markups.length}` }), h("small", { text: "markups" })]),
      ]),
      h("div", { class: "row" }, [storeyPick, rename, flip, remove]),
      ...(drift !== null && drift > 0.05
        ? [h("div", { class: "note error", text: `The placement and the calibration disagree by ${Math.round(drift * 100)}%. Re-pick the alignment pair further apart.` })]
        : []),
      ...(active.markups.length
        ? [h("div", { class: "sheet-markups" }, active.markups.map((markup) => {
            const row = h("div", { class: "filter-row" }, [
              h("span", { class: "grow", text: markup.text || markup.kind }),
              button("Issue", () => void raiseFromMarkup(markup).catch((error: Error) => ctx.feedback.log(error.message, "error"))),
              button("Delete", () => {
                if (!active) return;
                active.markups = active.markups.filter((entry) => entry.id !== markup.id);
                launch(save().then(() => paintPending()));
              }),
            ]);
            return row;
          }))]
        : []),
    );
  };

  const toolSelect = select(TOOLS, tool, (value) => {
    tool = value as Tool;
    pending = { points: [] };
    ctx.storage.write("tool", tool);
    paintPending();
  });

  const kindSelect = select(MARKUP_KINDS, markupKind, (value) => {
    markupKind = value;
    ctx.storage.write("markupKind", markupKind);
  });

  const overlayButton = button(overlayOn ? "Overlay on" : "Overlay off", () => {
    overlayOn = !overlayOn;
    ctx.storage.write("overlay", overlayOn);
    overlayButton.textContent = overlayOn ? "Overlay on" : "Overlay off";
    void paintOverlay();
  });

  const root = pageRoot(
    header("Sheets", "The issued drawing set, calibrated and linked to the model."),
    bar(
      button("Import sheet", () => file.click(), "accent"),
      toolSelect,
      kindSelect,
      overlayButton,
      button("Fit", () => fit()),
      button("Clear measurement", () => {
        measured = null;
        pending = { points: [] };
        paintPending();
      }),
    ),
    hint("layers", "Calibrate from two points and a known distance, then pair two points with the 3D view to place the sheet. After that the sheet measures in real units, overlays the model's own cut and selects elements when you click it."),
    importStatus.root,
    overlayStatus.root,
    h("div", { class: "sheet-workspace" }, [
      h("div", { class: "sheet-side" }, [list, info]),
      stage,
    ]),
    file,
  );

  host.appendChild(root);
  launch(reload());

  const onModel = ctx.events.on("model", () => {
    importController?.abort();
    reloadGeneration++;
    invalidateOverlay();
    sheets = [];
    active = null;
    measured = null;
    pending = { points: [] };
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = "";
    image.removeAttribute("src");
    paintPending();
    paintInfo();
    paintList();
    importStatus.hide();
    overlayStatus.hide();
    launch(reload());
  });

  return {
    dispose: () => {
      onModel();
      importController?.abort();
      reloadGeneration++;
      invalidateOverlay();
      importStatus.hide();
      overlayStatus.hide();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
  };
}
