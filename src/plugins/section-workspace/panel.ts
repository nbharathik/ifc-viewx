import {
  button, emptyState, field, h, hint, icon, iconButton, number, page, select,
} from "@ifcviewx/sdk";
import type {
  ExtensionContext, ExtensionInstance, SectionAxis, SectionContourResult, SectionPolyline, SectionState, SpatialNode,
} from "@ifcviewx/sdk";

type Box2 = { x: number; y: number; width: number; height: number };

interface StoreyCut {
  name: string;
  offset: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function pathOf(lines: readonly SectionPolyline[]): string {
  return lines.map((line) => line.points.map((point, index) =>
    `${index === 0 ? "M" : "L"}${point[0].toFixed(5)} ${(-point[1]).toFixed(5)}`).join(" ") + (line.closed ? " Z" : "")).join(" ");
}

function fittedBox(bounds: SectionContourResult["bounds"], aspect = 1): Box2 {
  if (!bounds) return { x: -5, y: -5, width: 10, height: 10 };
  const rawWidth = Math.max(0.1, bounds.max[0] - bounds.min[0]);
  const rawHeight = Math.max(0.1, bounds.max[1] - bounds.min[1]);
  const pad = Math.max(rawWidth, rawHeight) * 0.07;
  let width = rawWidth + pad * 2;
  let height = rawHeight + pad * 2;
  const safeAspect = Math.max(0.1, aspect);
  if (width / height > safeAspect) height = width / safeAspect;
  else width = height * safeAspect;
  const centerX = (bounds.min[0] + bounds.max[0]) / 2;
  const centerY = -(bounds.min[1] + bounds.max[1]) / 2;
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}

export function fitBounds(result: SectionContourResult | null, aspect = 1): Box2 {
  return fittedBox(result?.bounds ?? null, aspect);
}

function niceStep(span: number): number {
  const raw = Math.max(0.001, span / 6);
  const power = 10 ** Math.floor(Math.log10(raw));
  const scaled = raw / power;
  return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power;
}

function safeNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(Math.abs(value) < 1 ? 2 : 1);
}

/** A readable drafting scale that stays close to the requested screen width. */
export function scaleStep(worldWidth: number, pixelWidth: number, targetPixels = 84): number {
  const raw = Math.max(1e-6, worldWidth / Math.max(1, pixelWidth) * targetPixels);
  const power = 10 ** Math.floor(Math.log10(raw));
  const scaled = raw / power;
  return (scaled >= 5 ? 5 : scaled >= 2 ? 2 : 1) * power;
}

export function withWorkspacePlane(
  states: readonly SectionState[],
  plane: SectionState,
  previousAxis: SectionAxis | null = plane.axis,
): SectionState[] {
  return [...states.filter((state) => state.axis !== plane.axis && state.axis !== previousAxis), plane];
}

export function contourSelection(current: readonly number[], id: number, toggle: boolean): number[] {
  if (!toggle) return [id];
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return [...next];
}

export function hasSectionDrawing(
  result: SectionContourResult | null | undefined,
): result is SectionContourResult & { bounds: NonNullable<SectionContourResult["bounds"]> } {
  return result?.bounds !== null && result?.bounds !== undefined;
}

export function mount(host: HTMLElement, ctx: ExtensionContext): ExtensionInstance {
  let axis = ctx.storage.read<SectionAxis>("axis", "y");
  let offset = ctx.storage.read("offset", 0);
  let flip = ctx.storage.read("flip", false);
  let maxSegments = ctx.storage.read("maxSegments", 100_000);
  if (axis !== "x" && axis !== "y" && axis !== "z") axis = "y";
  if (!Number.isFinite(offset)) offset = 0;
  if (typeof flip !== "boolean") flip = false;
  if (![25_000, 100_000, 250_000].includes(maxSegments)) maxSegments = 100_000;
  let result: SectionContourResult | null = null;
  let viewport = fitBounds(null);
  let controller: AbortController | null = null;
  let runRequest = 0;
  let generation = 0;
  let running = false;
  let syncing = false;
  let workspaceAxis: SectionAxis | null = null;
  let rerunTimer = 0;
  let resultHandle = "";
  let hoverId: number | null = null;
  let drag: { x: number; y: number; view: Box2; moved: boolean } | null = null;
  let blockContourClick = false;
  let viewportFrame = 0;
  let storeys: StoreyCut[] = [];
  let floorController: AbortController | null = null;
  let floorBuilding = false;
  let floorProgress = -1;
  let floorPlans = new Map<number, SectionContourResult>();
  let contourGroups = new Map<number, SectionPolyline[]>();
  let axisControl: HTMLSelectElement | null = null;
  let offsetControl: HTMLInputElement | null = null;
  let storeyControl: HTMLSelectElement | null = null;
  let detailControl: HTMLSelectElement | null = null;
  let flipControl: HTMLButtonElement | null = null;
  let runControl: HTMLButtonElement | null = null;
  let fitDrawing = (): void => undefined;
  let focusDrawing = (): void => undefined;
  let zoomDrawing = (_factor: number): void => undefined;
  const elements = new Map(ctx.model.elements().map((element) => [element.id, element]));

  const controls = h("div", { class: "sw-controls" });
  const floorLibrary = h("div", { class: "sw-floor-library" });
  const status = h("div", { class: "sw-status" });
  const hover = h("div", { class: "sw-hover", text: "Select a line to identify it · double click to frame it" });
  const drawing = svg("svg", {
    class: "sw-sheet",
    role: "img",
    "aria-label": "Synchronized IFC section drawing",
    tabindex: "0",
  });
  const gridLayer = svg("g", { class: "sw-grid" });
  const contourLayer = svg("g", { class: "sw-contours" });
  drawing.append(gridLayer, contourLayer);
  const zoomOut = h("button", { class: "icon-btn sm sw-zoom", type: "button", title: "Zoom out", "aria-label": "Zoom drawing out", text: "−" });
  const zoomIn = h("button", { class: "icon-btn sm sw-zoom", type: "button", title: "Zoom in", "aria-label": "Zoom drawing in", text: "+" });
  zoomOut.addEventListener("click", () => zoomDrawing(1.25));
  zoomIn.addEventListener("click", () => zoomDrawing(0.8));
  const focusControl = iconButton("focus", "Fit selected contours", () => focusDrawing(), "icon-btn sm sw-focus");
  const drawingTools = h("div", { class: "sw-drawing-tools", "aria-label": "Drawing navigation" }, [
    zoomOut,
    zoomIn,
    iconButton("frame", "Fit the complete drawing", () => fitDrawing(), "icon-btn sm"),
    focusControl,
  ]);
  const scaleFill = h("i");
  const scaleLabel = h("span", { text: "10 m" });
  const scale = h("div", { class: "sw-scale", "aria-label": "Drawing scale" }, [scaleFill, scaleLabel]);
  const drawingWrap = h("div", { class: "sw-drawing" }, [drawing, drawingTools, scale, hover]);
  const root = page(
    h("header", { class: "sw-head" }, [
      h("div", {}, [h("h3", { text: "Plans and sections" }), h("p", { text: "Create coordinated drawings directly from the visible model." })]),
      h("span", { class: "sw-fidelity", text: "MESH" }),
    ]),
    controls,
    drawingWrap,
    status,
  );
  root.classList.add("section-workspace");

  const applyViewBox = (): void => {
    drawing.setAttribute("viewBox", `${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`);
  };

  const drawingAspect = (): number => {
    const rect = drawing.getBoundingClientRect();
    return rect.height > 0 ? rect.width / rect.height : 1;
  };

  const collectStoreys = (): StoreyCut[] => {
    const tree = ctx.model.tree();
    if (!tree) return [];
    const nodes: SpatialNode[] = [];
    const walk = (node: SpatialNode): void => {
      if (node.type === "IfcBuildingStorey") nodes.push(node);
      node.children.forEach(walk);
    };
    walk(tree);
    return nodes.flatMap((node) => {
      let base = Infinity;
      let top = -Infinity;
      for (const id of ctx.model.subtree(node.expressID)) {
        const bounds = ctx.model.bounds(id);
        if (!bounds) continue;
        base = Math.min(base, bounds.min.y);
        top = Math.max(top, bounds.max.y);
      }
      if (!Number.isFinite(base) || !Number.isFinite(top)) return [];
      return [{ name: node.name || `Storey #${node.expressID}`, offset: Math.min(top - 0.05, base + 1.2) }];
    }).sort((a, b) => b.offset - a.offset);
  };

  const indexContours = (): void => {
    contourGroups = new Map();
    for (const line of result?.polylines ?? []) {
      const lines = contourGroups.get(line.elementId);
      if (lines) lines.push(line);
      else contourGroups.set(line.elementId, [line]);
    }
  };

  const drawGrid = (): void => {
    gridLayer.replaceChildren();
    const step = niceStep(Math.max(viewport.width, viewport.height));
    const rect = drawing.getBoundingClientRect();
    const unitsPerPixel = Math.max(
      viewport.width / Math.max(1, rect.width),
      viewport.height / Math.max(1, rect.height),
    );
    const fontSize = Math.max(unitsPerPixel * 9, viewport.width / 2_000);
    const insetX = unitsPerPixel * 7;
    const insetY = unitsPerPixel * 12;
    const xStart = Math.floor(viewport.x / step) * step;
    const xEnd = viewport.x + viewport.width;
    const worldMinY = -(viewport.y + viewport.height);
    const worldMaxY = -viewport.y;
    const yStart = Math.floor(worldMinY / step) * step;
    const fragment = document.createDocumentFragment();
    for (let x = xStart; x <= xEnd; x += step) {
      fragment.append(svg("line", { x1: String(x), y1: String(viewport.y), x2: String(x), y2: String(viewport.y + viewport.height) }));
      const label = svg("text", {
        x: String(x + insetX),
        y: String(viewport.y + insetY),
        "font-size": String(fontSize),
      });
      label.textContent = safeNumber(x);
      fragment.append(label);
    }
    for (let y = yStart; y <= worldMaxY; y += step) {
      fragment.append(svg("line", { x1: String(viewport.x), y1: String(-y), x2: String(xEnd), y2: String(-y) }));
      const label = svg("text", {
        x: String(viewport.x + insetX),
        y: String(-y - insetX),
        "font-size": String(fontSize),
      });
      label.textContent = safeNumber(y);
      fragment.append(label);
    }
    const datum = svg("g", { class: "sw-datum" });
    datum.append(
      svg("line", { x1: "0", y1: String(viewport.y), x2: "0", y2: String(viewport.y + viewport.height) }),
      svg("line", { x1: String(viewport.x), y1: "0", x2: String(xEnd), y2: "0" }),
      svg("circle", { cx: "0", cy: "0", r: String(unitsPerPixel * 4) }),
    );
    fragment.append(datum);
    gridLayer.append(fragment);

    const scaleWorld = scaleStep(unitsPerPixel * rect.width, rect.width);
    scaleFill.style.width = `${Math.max(28, Math.min(116, scaleWorld / unitsPerPixel))}px`;
    scaleLabel.textContent = `${safeNumber(scaleWorld)} m`;
  };

  const paintViewport = (): void => {
    viewportFrame = 0;
    applyViewBox();
    drawGrid();
  };

  const queueViewportPaint = (): void => {
    if (viewportFrame) return;
    viewportFrame = requestAnimationFrame(paintViewport);
  };

  fitDrawing = (): void => {
    viewport = fitBounds(result, drawingAspect());
    paintViewport();
  };

  zoomDrawing = (factor: number): void => {
    const nextWidth = Math.max(1e-4, Math.min(1e7, viewport.width * factor));
    const nextHeight = viewport.height * (nextWidth / viewport.width);
    viewport = {
      x: viewport.x + (viewport.width - nextWidth) / 2,
      y: viewport.y + (viewport.height - nextHeight) / 2,
      width: nextWidth,
      height: nextHeight,
    };
    queueViewportPaint();
  };

  const selectedBounds = (): SectionContourResult["bounds"] => {
    const selected = new Set(ctx.view.selection());
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of selected) {
      for (const line of contourGroups.get(id) ?? []) {
        for (const [x, y] of line.points) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    return Number.isFinite(minX) ? { min: [minX, minY], max: [maxX, maxY] } : null;
  };

  focusDrawing = (): void => {
    const bounds = selectedBounds();
    if (!bounds) return void ctx.feedback.toast("Select a contour first", "info");
    viewport = fittedBox(bounds, drawingAspect());
    paintViewport();
  };

  const identifyText = (): string => {
    const selected = ctx.view.selection().filter((id) => contourGroups.has(id));
    const id = hoverId ?? (selected.length === 1 ? selected[0] : null);
    if (id !== null) {
      const lines = contourGroups.get(id) ?? [];
      const element = elements.get(id);
      const label = element?.name || element?.type || lines[0]?.elementType || "IFC element";
      return `${hoverId === null ? "Selected · " : ""}${label}  #${ctx.model.expressOf(id)}`;
    }
    if (selected.length > 1) return `${selected.length.toLocaleString()} selected elements cross this drawing`;
    return "Select a line to identify it · double click to frame it";
  };

  const syncSelection = (): void => {
    const selected = new Set(ctx.view.selection());
    for (const path of contourLayer.querySelectorAll<SVGPathElement>(".sw-contour")) {
      path.classList.toggle("selected", selected.has(Number(path.dataset.id)));
    }
    focusControl.disabled = ![...selected].some((id) => contourGroups.has(id));
    hover.textContent = identifyText();
  };

  const drawContours = (): void => {
    contourLayer.replaceChildren();
    const selected = new Set(ctx.view.selection());
    const fragment = document.createDocumentFragment();
    for (const [id, lines] of contourGroups) {
      const element = elements.get(id);
      const label = element?.name || element?.type || lines[0].elementType;
      const path = svg("path", {
        d: pathOf(lines),
        class: `sw-contour${selected.has(id) ? " selected" : ""}${lines.some((line) => !line.closed) ? " open" : ""}`,
        "data-id": String(id),
        "aria-label": `${label}, element ${ctx.model.expressOf(id)}`,
        tabindex: "0",
      });
      const identify = (): void => {
        hoverId = id;
        hover.textContent = identifyText();
      };
      path.addEventListener("pointerenter", identify);
      path.addEventListener("focus", identify);
      path.addEventListener("pointerleave", () => {
        if (hoverId === id) hoverId = null;
        hover.textContent = identifyText();
      });
      path.addEventListener("blur", () => {
        if (hoverId === id) hoverId = null;
        hover.textContent = identifyText();
      });
      path.addEventListener("click", (event) => {
        if (blockContourClick) return;
        const toggle = event.ctrlKey || event.metaKey || event.shiftKey;
        ctx.view.select(contourSelection(ctx.view.selection(), id, toggle));
      });
      path.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        const toggle = event.ctrlKey || event.metaKey || event.shiftKey;
        ctx.view.select(contourSelection(ctx.view.selection(), id, toggle));
      });
      path.addEventListener("dblclick", () => ctx.view.frame(id));
      fragment.append(path);
    }
    contourLayer.append(fragment);
    syncSelection();
  };

  const storeRows = (): void => {
    if (!result) return;
    const current = result;
    const groups = [...contourGroups];
    if (resultHandle) ctx.results.dispose(resultHandle);
    const rows = groups.slice(0, 10_000).map(([id, lines]) => ({
      id,
      type: elements.get(id)?.type || lines[0].elementType,
      name: elements.get(id)?.name || "",
      loops: lines.length,
      closed: lines.filter((line) => line.closed).length,
      open: lines.filter((line) => !line.closed).length,
      lengthM: Number(lines.reduce((sum, line) => sum + line.length, 0).toFixed(4)),
      axis,
      offset,
      fidelity: current.fidelity,
    }));
    resultHandle = ctx.results.create("section-workspace.results", rows, {
      metadata: {
        axis,
        offset,
        geometryRevision: current.geometryRevision,
        truncated: current.truncated,
        rowsTruncated: groups.length > rows.length,
      },
    }).id;
  };

  const paintStatus = (): void => {
    root.classList.toggle("updating", running);
    if (!result) return void status.replaceChildren(hint("info", running ? "Building the first drawing…" : "Set a plane to build the drawing."));
    if (!result.bounds) {
      status.replaceChildren(hint("info", running
        ? "Rebuilding this empty cut..."
        : "No visible geometry crosses this plane."));
      return;
    }
    const elementCount = contourGroups.size;
    status.replaceChildren(
      h("div", { class: "sw-metrics", role: "status", "aria-live": "polite" }, [
        h("span", {}, [h("b", { text: elementCount.toLocaleString() }), h("small", { text: "elements" })]),
        h("span", {}, [h("b", { text: result.polylines.length.toLocaleString() }), h("small", { text: "paths" })]),
        h("span", { class: result.openCount ? "warn" : "" }, [h("b", { text: result.openCount.toLocaleString() }), h("small", { text: "open" })]),
        h("span", {}, [h("b", { text: `${result.elapsedMs}` }), h("small", { text: "ms" })]),
      ]),
      result.truncated
        ? hint("alert", `The ${maxSegments.toLocaleString()} segment limit was reached. Increase detail or narrow the visible model.`)
        : result.openCount
          ? h("details", { class: "sw-diagnostics" }, [
              h("summary", {}, [icon("info", 12), ` Why ${result.openCount.toLocaleString()} paths are dashed`]),
              h("p", { text: "Open paths mark mesh edges, incomplete retained geometry, or surfaces that do not form a closed solid at this cut." }),
            ])
          : h("p", { class: "sw-ready", text: "Closed contours are ready for review and SVG export." }),
    );
  };

  const applyPlane = (): void => {
    syncing = true;
    try {
      ctx.view.setSections(withWorkspacePlane(ctx.view.sections(), { axis, offset, flip }, workspaceAxis));
      workspaceAxis = axis;
      ctx.storage.write("axis", axis);
      ctx.storage.write("offset", offset);
      ctx.storage.write("flip", flip);
    } finally {
      syncing = false;
    }
  };

  const stopCurrentRun = (): void => {
    controller?.abort();
    controller = null;
    runRequest += 1;
    running = false;
  };

  const run = async (updatePlane = true): Promise<void> => {
    controller?.abort();
    const request = ++runRequest;
    const localGeneration = generation;
    const requestAxis = axis;
    const requestOffset = offset;
    const requestFlip = flip;
    const requestMaxSegments = maxSegments;
    const next = new AbortController();
    controller = next;
    running = true;
    if (updatePlane) applyPlane();
    syncControls();
    paintStatus();
    const isCurrent = (): boolean => generation === localGeneration
      && request === runRequest
      && controller === next
      && !next.signal.aborted
      && axis === requestAxis
      && offset === requestOffset
      && flip === requestFlip
      && maxSegments === requestMaxSegments;
    try {
      const nextResult = await ctx.geometry.sectionContours(requestAxis, requestOffset, {
        maxSegments: requestMaxSegments,
        signal: next.signal,
      });
      if (!isCurrent()) return;
      result = nextResult;
      if (requestAxis === "y") {
        const floorIndex = storeys.findIndex((storey) => Math.abs(storey.offset - requestOffset) < 1e-5);
        if (floorIndex >= 0) {
          floorPlans.set(floorIndex, nextResult);
          paintFloorLibrary();
        }
      }
      indexContours();
      viewport = fitBounds(result, drawingAspect());
      paintViewport();
      drawContours();
      storeRows();
      ctx.storage.write("axis", axis);
      ctx.storage.write("offset", offset);
      ctx.storage.write("flip", flip);
      ctx.feedback.publishFindings(
        `${result.polylines.length.toLocaleString()} section paths from ${contourGroups.size.toLocaleString()} elements.`,
        result.truncated ? [{ severity: "warning", title: "Section output is partial", detail: "Raise the segment limit or reduce visible geometry." }] : [],
      );
    } catch (error) {
      if (!isCurrent()) return;
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
      }
    } finally {
      if (controller === next && request === runRequest) {
        controller = null;
        running = false;
        if (generation === localGeneration) {
          syncControls();
          paintStatus();
        }
      }
    }
  };

  const scheduleRun = (delay = 100): void => {
    window.clearTimeout(rerunTimer);
    rerunTimer = window.setTimeout(() => void run(false), delay);
  };

  const groupsOf = (drawingResult: SectionContourResult): Map<number, SectionPolyline[]> => {
    const groups = new Map<number, SectionPolyline[]>();
    for (const line of drawingResult.polylines) {
      const lines = groups.get(line.elementId);
      if (lines) lines.push(line);
      else groups.set(line.elementId, [line]);
    }
    return groups;
  };

  const escapeMarkup = (value: string): string => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

  const svgContent = (drawingResult: SectionContourResult, label: string): string => {
    const view = fitBounds(drawingResult);
    const paths = [...groupsOf(drawingResult)].map(([id, lines]) =>
      `<path data-element="${id}" d="${pathOf(lines)}"/>`).join("");
    const stroke = Math.max(view.width, view.height) / 850;
    return `<svg xmlns="${SVG_NS}" viewBox="${view.x} ${view.y} ${view.width} ${view.height}"><metadata>${escapeMarkup(label)}</metadata><g fill="none" stroke="#111827" stroke-width="${stroke}">${paths}</g></svg>`;
  };

  const filePart = (value: string): string => value.trim().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "floor";

  const exportSvg = (): void => {
    if (!hasSectionDrawing(result)) return void ctx.feedback.toast("Build a section before exporting", "info");
    const content = svgContent(result, `IFCViewX mesh section ${axis.toUpperCase()}=${offset.toFixed(4)} m`);
    const name = `section-${axis}-${offset.toFixed(3).replace("-", "m")}.svg`;
    ctx.files.export("section-workspace.svg", name, content, "image/svg+xml");
  };

  const exportFloor = (index: number): void => {
    const storey = storeys[index];
    const plan = floorPlans.get(index);
    if (!storey || !hasSectionDrawing(plan)) return void ctx.feedback.toast("Build this floor plan before downloading it", "info");
    ctx.files.export(
      "section-workspace.svg",
      `plan-${filePart(storey.name)}.svg`,
      svgContent(plan, `IFCViewX floor plan ${storey.name} at ${storey.offset.toFixed(3)} m`),
      "image/svg+xml",
    );
  };

  const exportFloorBook = (): void => {
    const ready = [...floorPlans].filter(([, plan]) => hasSectionDrawing(plan));
    if (!ready.length) return void ctx.feedback.toast("Build at least one floor plan before downloading the set", "info");
    const sheets = ready.map(([index, plan]) => {
      const storey = storeys[index];
      return `<section><header><h1>${escapeMarkup(storey.name)}</h1><span>Cut at ${storey.offset.toFixed(3)} m</span></header>${svgContent(plan, `IFCViewX floor plan ${storey.name}`)}</section>`;
    }).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>IFCViewX floor plans</title><style>body{margin:0;background:#e5e7eb;color:#111827;font:14px system-ui,sans-serif}section{box-sizing:border-box;width:297mm;min-height:210mm;margin:12mm auto;padding:14mm;background:#fff;page-break-after:always}header{display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid #9ca3af}h1{font-size:18px}span{color:#6b7280}svg{display:block;width:100%;height:160mm;margin-top:10mm}@media print{body{background:#fff}section{margin:0}}</style></head><body>${sheets}</body></html>`;
    ctx.files.export("section-workspace.booklet", "ifc-floor-plans.html", html, "text/html");
  };

  const stopFloorBuild = (clearCache: boolean): void => {
    const active = floorController;
    active?.abort();
    if (floorController === active) {
      floorController = null;
      floorBuilding = false;
      floorProgress = -1;
    }
    if (clearCache) floorPlans.clear();
    paintFloorLibrary();
  };

  const showFloor = async (index: number): Promise<void> => {
    const storey = storeys[index];
    if (!storey) return;
    if (floorBuilding) stopFloorBuild(false);
    axis = "y";
    offset = storey.offset;
    flip = false;
    const cached = floorPlans.get(index);
    if (!cached) {
      await run();
    } else {
      stopCurrentRun();
      result = cached;
      applyPlane();
      indexContours();
      viewport = fitBounds(result, drawingAspect());
      paintViewport();
      drawContours();
      storeRows();
      paintStatus();
    }
    syncControls();
    paintFloorLibrary();
  };

  const buildAllFloorPlans = async (rebuild = false): Promise<void> => {
    if (!storeys.length || floorBuilding) return;
    const localGeneration = generation;
    const next = new AbortController();
    floorController = next;
    if (rebuild) floorPlans.clear();
    if (floorPlans.size >= storeys.length) {
      floorController = null;
      paintFloorLibrary();
      return;
    }
    floorBuilding = true;
    floorProgress = -1;
    paintFloorLibrary();
    try {
      for (let index = 0; index < storeys.length; index++) {
        if (floorPlans.has(index)) continue;
        floorProgress = index;
        paintFloorLibrary();
        const storey = storeys[index];
        const plan = await ctx.geometry.sectionContours("y", storey.offset, {
          maxSegments,
          signal: next.signal,
        });
        if (generation !== localGeneration || floorController !== next || next.signal.aborted) return;
        floorPlans.set(index, plan);
      }
    } catch (error) {
      if (generation !== localGeneration || floorController !== next || next.signal.aborted) return;
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
      }
    } finally {
      if (floorController === next) {
        floorController = null;
        floorBuilding = false;
        floorProgress = -1;
        if (generation === localGeneration) paintFloorLibrary();
      }
    }
  };

  const paintFloorLibrary = (): void => {
    if (!storeys.length) {
      floorLibrary.replaceChildren(hint("info", "No IfcBuildingStorey levels were found. Use the plane offset for a manual cut."));
      return;
    }
    const built = floorPlans.size;
    const ready = [...floorPlans.values()].filter(hasSectionDrawing).length;
    const empty = built - ready;
    const complete = built === storeys.length;
    const downloadAll = button(complete ? `Download set (${ready})` : `Download ready (${ready})`, exportFloorBook, "accent");
    downloadAll.disabled = ready === 0;
    const buildLabel = floorBuilding ? "Stop build" : complete ? "Rebuild all" : built ? "Build remaining" : "Build all";
    const build = button(buildLabel, () => {
      if (floorBuilding) stopFloorBuild(false);
      else void buildAllFloorPlans(complete);
    });
    const rows = storeys.map((storey, index) => {
      const plan = floorPlans.get(index);
      const builtPlan = floorPlans.has(index);
      const drawable = hasSectionDrawing(plan);
      const current = axis === "y" && Math.abs(offset - storey.offset) < 1e-5;
      const floorState = drawable
        ? "Ready"
        : builtPlan
          ? "Empty"
          : floorProgress === index
            ? "Building now"
            : floorBuilding
              ? "Waiting to build"
              : "Not built";
      const open = h("button", {
        class: "sw-floor-open",
        type: "button",
        "aria-current": current ? "true" : "false",
        "aria-label": `${storey.name}, ${storey.offset.toFixed(2)} metres, ${floorState.toLowerCase()}`,
      }, [
        h("span", { text: storey.name }),
        h("small", { text: `${storey.offset.toFixed(2)} m` }),
      ]);
      open.addEventListener("click", () => void showFloor(index));
      const download = iconButton("download", `Download ${storey.name} SVG`, () => exportFloor(index), "icon-btn sm");
      download.disabled = !drawable;
      return h("div", { class: "sw-floor-row" }, [
        h("span", {
          class: `sw-floor-state${drawable ? " ready" : builtPlan ? " empty" : floorProgress === index ? " building" : ""}`,
          title: floorState,
        }),
        open,
        download,
      ]);
    });
    const summary = floorBuilding
      ? `Building ${Math.max(1, floorProgress + 1)} of ${storeys.length}`
      : built === 0
        ? "Not built"
        : complete
          ? empty ? `${ready} ready / ${empty} empty` : `${ready} ready`
          : `${built}/${storeys.length} built`;
    floorLibrary.replaceChildren(h("details", { class: "sw-floors", open: "" }, [
      h("summary", {}, [
        icon("layers", 13),
        h("span", { text: "Floor plans" }),
        h("small", { text: summary }),
      ]),
      h("div", { class: "sw-floor-actions" }, [build, downloadAll]),
      h("div", { class: "sw-floor-list" }, rows),
    ]));
  };

  const syncControls = (): void => {
    if (axisControl) axisControl.value = axis;
    if (offsetControl && document.activeElement !== offsetControl) offsetControl.value = String(Number(offset.toFixed(4)));
    if (storeyControl && axis !== "y") storeyControl.value = "";
    if (detailControl) detailControl.value = String(maxSegments);
    if (flipControl) {
      flipControl.textContent = flip ? "Keep + side" : "Keep − side";
      flipControl.setAttribute("aria-pressed", String(flip));
      flipControl.title = flip ? "Keep geometry above the plane" : "Keep geometry below the plane";
    }
    if (runControl) {
      runControl.textContent = running ? "Stop" : workspaceAxis === null ? "Apply plane" : "Rebuild";
      runControl.classList.toggle("stop", running);
      runControl.classList.toggle("primary", !running);
      runControl.setAttribute(
        "aria-label",
        running ? "Stop rebuilding the drawing" : workspaceAxis === null ? "Apply the section plane" : "Rebuild the drawing",
      );
    }
  };

  const paintControls = (): void => {
    axisControl = select([["x", "Section / X"], ["y", "Plan / Y"], ["z", "Section / Z"]], axis, (value) => {
      axis = value as SectionAxis;
      const selected = ctx.view.selection();
      const box = ctx.view.boxAround(selected.length ? selected : [...elements.keys()], 0);
      if (box) {
        const index = axis === "x" ? 0 : axis === "y" ? 1 : 2;
        offset = (box.min[index] + box.max[index]) / 2;
      }
      syncControls();
      void run();
    });
    axisControl.setAttribute("aria-label", "Section plane");
    offsetControl = number(offset, (value) => {
      if (!Number.isFinite(value)) return;
      offset = value;
      void run();
    }, 0.01, -1_000_000);
    offsetControl.setAttribute("aria-label", "Section offset in metres");
    storeyControl = storeys.length ? select(
      [["", "Choose storey"], ...storeys.map((storey, index): [string, string] => [String(index), storey.name])],
      "",
      (value) => {
        const storey = storeys[Number(value)];
        if (!storey) return;
        void showFloor(Number(value));
      },
    ) : null;
    detailControl = select([["25000", "Fast · 25k"], ["100000", "Balanced · 100k"], ["250000", "Detailed · 250k"]], String(maxSegments), (value) => {
      maxSegments = Number(value);
      ctx.storage.write("maxSegments", maxSegments);
      stopFloorBuild(true);
      void run(workspaceAxis === null);
    });
    flipControl = button("", () => { flip = !flip; syncControls(); void run(); });
    runControl = button("", () => {
      if (!running) return void run(workspaceAxis === null);
      stopCurrentRun();
      syncControls();
      paintStatus();
    });
    runControl.classList.add("sw-rebuild");
    const align = button("Align 3D", () => ctx.view.viewFrom(axis === "y" ? "top" : axis === "x" ? "right" : "front"));
    const exportControl = button("Download SVG", exportSvg, "accent");
    const advanced = h("details", { class: "sw-options" }, [
      h("summary", {}, [icon("sliders", 13), h("span", { text: "Drawing detail" }), h("small", { text: `${(maxSegments / 1_000).toLocaleString()}k max` })]),
      h("div", { class: "sw-options-body" }, [
        field("Segment budget", detailControl),
        h("p", { text: "Use Detailed only for dense visible geometry. The current drawing remains usable while it rebuilds." }),
      ]),
    ]);
    controls.replaceChildren(
      h("div", { class: "sw-plane-controls" }, [
        field("Plane", axisControl),
        field("Cut at (m)", offsetControl),
        ...(storeyControl ? [field("Storey", storeyControl)] : []),
      ]),
      h("div", { class: "sw-actions" }, [flipControl, align, runControl, exportControl]),
      floorLibrary,
      advanced,
    );
    syncControls();
    paintFloorLibrary();
  };

  const initialise = (): void => {
    generation += 1;
    stopCurrentRun();
    floorController?.abort();
    floorController = null;
    floorBuilding = false;
    floorProgress = -1;
    floorPlans = new Map();
    elements.clear();
    for (const element of ctx.model.elements()) elements.set(element.id, element);
    storeys = collectStoreys();
    const sections = ctx.view.sections();
    const active = sections.find((state) => state.axis === axis) ?? sections[0];
    const selected = ctx.view.selection();
    const box = ctx.view.boxAround(selected.length ? selected : [...elements.keys()], 0);
    if (active) {
      axis = active.axis;
      offset = active.offset;
      flip = active.flip;
      workspaceAxis = active.axis;
    } else if (box) {
      workspaceAxis = null;
      const index = axis === "x" ? 0 : axis === "y" ? 1 : 2;
      offset = (box.min[index] + box.max[index]) / 2;
    } else {
      workspaceAxis = null;
    }
    result = null;
    contourGroups.clear();
    if (resultHandle) ctx.results.dispose(resultHandle);
    resultHandle = "";
    paintControls();
    if (ctx.session.model().loaded) void run();
    else {
      contourLayer.replaceChildren();
      status.replaceChildren(emptyState("section", "No model loaded", "Open an IFC model to build a synchronized section."));
    }
  };

  drawing.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = drawing.getBoundingClientRect();
    const px = (event.clientX - rect.left) / Math.max(1, rect.width);
    const py = (event.clientY - rect.top) / Math.max(1, rect.height);
    const factor = Math.exp(Math.max(-1, Math.min(1, event.deltaY * 0.0015)));
    const width = Math.max(1e-4, Math.min(1e7, viewport.width * factor));
    const height = viewport.height * (width / viewport.width);
    viewport = {
      x: viewport.x + viewport.width * px - width * px,
      y: viewport.y + viewport.height * py - height * py,
      width,
      height,
    };
    queueViewportPaint();
  }, { passive: false });
  drawing.addEventListener("pointerdown", (event) => {
    const onContour = (event.target as Element).classList.contains("sw-contour");
    if ((event.button !== 0 && event.button !== 1) || (onContour && event.button === 0 && !event.shiftKey)) return;
    event.preventDefault();
    drag = { x: event.clientX, y: event.clientY, view: { ...viewport }, moved: false };
    drawing.setPointerCapture(event.pointerId);
  });
  drawing.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const rect = drawing.getBoundingClientRect();
    drag.moved ||= Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 3;
    viewport = {
      ...drag.view,
      x: drag.view.x - (event.clientX - drag.x) / Math.max(1, rect.width) * drag.view.width,
      y: drag.view.y - (event.clientY - drag.y) / Math.max(1, rect.height) * drag.view.height,
    };
    queueViewportPaint();
  });
  const finishDrag = (): void => {
    if (drag?.moved) {
      blockContourClick = true;
      window.setTimeout(() => { blockContourClick = false; }, 0);
    }
    drag = null;
  };
  drawing.addEventListener("pointerup", finishDrag);
  drawing.addEventListener("pointercancel", finishDrag);
  drawing.addEventListener("keydown", (event) => {
    if (event.target !== drawing) return;
    const panX = viewport.width * 0.08;
    const panY = viewport.height * 0.08;
    if (event.key === "+" || event.key === "=") zoomDrawing(0.8);
    else if (event.key === "-") zoomDrawing(1.25);
    else if (event.key === "0") fitDrawing();
    else if (event.key.toLowerCase() === "f") focusDrawing();
    else if (event.key === "ArrowLeft") viewport.x -= panX;
    else if (event.key === "ArrowRight") viewport.x += panX;
    else if (event.key === "ArrowUp") viewport.y -= panY;
    else if (event.key === "ArrowDown") viewport.y += panY;
    else return;
    event.preventDefault();
    queueViewportPaint();
  });

  ctx.events.on("selection", syncSelection);
  ctx.events.on("section", () => {
    if (syncing) return;
    const sections = ctx.view.sections();
    const active = sections.find((state) => state.axis === axis) ?? sections[0];
    if (!active) {
      window.clearTimeout(rerunTimer);
      stopCurrentRun();
      result = null;
      workspaceAxis = null;
      contourGroups.clear();
      contourLayer.replaceChildren();
      syncControls();
      paintStatus();
      return;
    }
    if (active.axis === axis && active.offset === offset && active.flip === flip) return;
    stopCurrentRun();
    axis = active.axis;
    offset = active.offset;
    flip = active.flip;
    workspaceAxis = active.axis;
    syncControls();
    scheduleRun();
  });
  ctx.events.on("visibility", () => {
    stopFloorBuild(true);
    if (ctx.session.model().loaded && workspaceAxis !== null) void run(false);
  });
  ctx.events.on("model", initialise);
  ctx.commands.register("section-workspace.open", syncControls);

  host.appendChild(root);
  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(queueViewportPaint);
  resizeObserver?.observe(drawingWrap);
  paintViewport();
  initialise();
  return {
    dispose: () => {
      window.clearTimeout(rerunTimer);
      if (viewportFrame) cancelAnimationFrame(viewportFrame);
      resizeObserver?.disconnect();
      stopCurrentRun();
      floorController?.abort();
      if (resultHandle) ctx.results.dispose(resultHandle);
    },
  };
}
