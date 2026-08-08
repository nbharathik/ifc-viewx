import {
  bar, button, emptyState, field, formatLength, h, hint, number, page,
} from "@ifcviewx/sdk";
import type {
  DistanceResult, ExtensionContextV2, LaserAxisResult, LaserResult, PluginInstance,
} from "@ifcviewx/sdk";

type Point = [number, number, number];

type SmartDistanceResult = Omit<DistanceResult, "fidelity" | "engine"> & { fidelity: string; engine: string };

interface DistanceState {
  result: SmartDistanceResult;
  measurementId: number | null;
}

const mm = (metres: number | null): string => metres === null ? "-" : `${Math.round(metres * 1000).toLocaleString()} mm`;

export function mount(host: HTMLElement, ctx: ExtensionContextV2): PluginInstance {
  let a: number | null = null;
  let b: number | null = null;
  let thresholdMm = ctx.storage.read("thresholdMm", 50);
  let maxDistanceM = ctx.storage.read("maxDistanceM", 30);
  let precise = ctx.storage.read("precise", false);
  let distance: DistanceState | null = null;
  let laser: LaserResult | null = null;
  let armed = false;
  let running: "distance" | "laser" | null = null;
  let controller: AbortController | null = null;
  let resultHandle = "";
  let generation = 0;
  const root = page();
  root.classList.add("smart-measure");

  const names = (): Map<number, string> => new Map(ctx.model.elements().map((element) => [element.id, element.name || element.type]));
  const label = (id: number | null): string => {
    if (id === null) return "not set";
    return `${names().get(id) ?? "Element"}  #${ctx.model.expressOf(id)}`;
  };

  const clearLiveLaser = (): void => {
    ctx.overlays.clear();
  };

  const setPairFromSelection = (): void => {
    const selected = ctx.view.selection();
    if (selected.length < 2) return void ctx.feedback.toast("Select two elements first", "error");
    [a, b] = selected.slice(-2) as [number, number];
    paint();
  };

  const setSlot = (slot: "a" | "b"): void => {
    const selected = ctx.view.selection();
    const id = selected[selected.length - 1];
    if (!id) return void ctx.feedback.toast("Select an element first", "error");
    if (slot === "a") a = id;
    else b = id;
    paint();
  };

  const storeResult = (kind: string, rows: unknown[], metadata: Record<string, unknown>): void => {
    if (resultHandle) ctx.results.dispose(resultHandle);
    resultHandle = ctx.results.create("smart-measure.results", rows, { metadata: { kind, ...metadata } }).id;
  };

  const runDistance = async (): Promise<void> => {
    if (!a || !b || a === b) return void ctx.feedback.toast("Set two different elements", "error");
    controller?.abort();
    const localGeneration = generation;
    const next = new AbortController();
    controller = next;
    running = "distance";
    armed = false;
    paint();
    try {
      const mesh = await ctx.geometry.distance(a, b, { signal: next.signal });
      let result: DistanceState["result"] = mesh;
      if (precise) {
        if (ctx.model.modelOf(a) !== 0 || ctx.model.modelOf(b) !== 0) {
          throw new Error("Local precise distance currently supports two elements from the primary IFC source");
        }
        const native = await ctx.local.invoke<{
          distance: number | null;
          intersecting: boolean;
          fidelity: string;
          engine: string;
        }>("geometry.precise-distance", {
          a: ctx.model.expressOf(a),
          b: ctx.model.expressOf(b),
          maxDistance: Math.max(maxDistanceM, mesh.distance ?? 0),
        }, next.signal);
        result = {
          ...mesh,
          distance: native.distance,
          intersecting: native.intersecting,
          fidelity: native.fidelity,
          engine: native.engine,
        };
      }
      if (generation !== localGeneration) return;
      let measurementId: number | null = null;
      if (result.pointA && result.pointB && result.distance !== null) {
        measurementId = ctx.view.addMeasurement(result.pointA, result.pointB).id;
        ctx.view.select([a, b]);
        if (result.point) ctx.view.frameAt(result.point, Math.max(0.5, (result.distance || 0.2) * 2.5));
      }
      distance = { result, measurementId };
      const distanceMm = result.distance === null ? null : Number((result.distance * 1000).toFixed(2));
      storeResult("distance", [{
        a, b, distanceMm, pointA: result.pointA, pointB: result.pointB,
        thresholdMm, pass: distanceMm !== null && !result.intersecting && distanceMm >= thresholdMm,
        fidelity: result.fidelity, engine: result.engine,
      }], { thresholdMm, geometryRevision: result.geometryRevision });
      const failed = result.distance === null || result.intersecting || result.distance * 1000 < thresholdMm;
      ctx.feedback.publishFindings(
        result.distance === null ? "The selected pair has no retained mesh distance." : `Shortest distance: ${mm(result.distance)}.`,
        failed ? [{ severity: "warning", title: "Clearance below the requested threshold", detail: `${thresholdMm} mm required` }] : [],
      );
      ctx.feedback.log(result.distance === null ? "No distance was available" : `Measured ${mm(result.distance)}`, failed ? "info" : "success");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
      }
    } finally {
      if (controller === next) controller = null;
      running = null;
      if (generation === localGeneration) paint();
    }
  };

  const drawLaser = (result: LaserResult): void => {
    clearLiveLaser();
    for (const axis of result.axes) {
      if (axis.negative) ctx.overlays.line("smart-measure.laser", result.origin, axis.negative.point);
      if (axis.positive) ctx.overlays.line("smart-measure.laser", result.origin, axis.positive.point);
    }
  };

  const runLaser = async (): Promise<void> => {
    const pick = ctx.view.lastPick();
    if (!pick) return void ctx.feedback.toast("Click a model surface first", "error");
    controller?.abort();
    const localGeneration = generation;
    const next = new AbortController();
    controller = next;
    running = "laser";
    armed = false;
    paint();
    try {
      const result = await ctx.geometry.laser(pick.point, {
        source: pick.expressID,
        maxDistance: maxDistanceM,
        signal: next.signal,
      });
      if (generation !== localGeneration) return;
      laser = result;
      drawLaser(result);
      const rows = result.axes.flatMap((axis) => [axis.negative, axis.positive]
        .filter((hit): hit is NonNullable<typeof hit> => hit !== null)
        .map((hit) => ({
          axis: hit.axis, direction: hit.direction, id: hit.elementId, type: hit.elementType,
          distanceMm: Number((hit.distance * 1000).toFixed(2)), point: hit.point,
        })));
      storeResult("laser", rows, {
        origin: result.origin,
        source: result.source,
        sourceNormal: result.sourceNormal,
        geometryRevision: result.geometryRevision,
      });
      ctx.feedback.log(`Laser found ${rows.length} of 6 axis surfaces`, rows.length === 6 ? "success" : "info");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
      }
    } finally {
      if (controller === next) controller = null;
      running = null;
      if (generation === localGeneration) paint();
    }
  };

  const keepLaser = (): void => {
    if (!laser) return;
    let kept = 0;
    for (const axis of laser.axes) {
      const start = axis.negative?.point ?? laser.origin;
      const end = axis.positive?.point ?? laser.origin;
      if (start === laser.origin && end === laser.origin) continue;
      ctx.view.addMeasurement(start, end);
      kept += 1;
    }
    clearLiveLaser();
    ctx.feedback.toast(`Kept ${kept} axis measurement${kept === 1 ? "" : "s"}`, "success");
    paint();
  };

  const alignSurface = (): void => {
    if (!laser?.sourceNormal) return void ctx.feedback.toast("The picked surface has no usable normal", "error");
    const pose = ctx.view.camera();
    const normal = [...laser.sourceNormal] as Point;
    const from: Point = [
      pose.position[0] - laser.origin[0],
      pose.position[1] - laser.origin[1],
      pose.position[2] - laser.origin[2],
    ];
    if (from[0] * normal[0] + from[1] * normal[1] + from[2] * normal[2] < 0) {
      normal[0] *= -1;
      normal[1] *= -1;
      normal[2] *= -1;
    }
    const reach = Math.max(1, Math.hypot(
      pose.position[0] - pose.target[0], pose.position[1] - pose.target[1], pose.position[2] - pose.target[2],
    ));
    ctx.view.setCamera({
      target: [...laser.origin],
      position: [
        laser.origin[0] + normal[0] * reach,
        laser.origin[1] + normal[1] * reach,
        laser.origin[2] + normal[2] * reach,
      ],
    });
  };

  const axisRow = (axis: LaserAxisResult): HTMLElement => {
    const hits = [axis.negative, axis.positive].filter((hit) => hit !== null).length;
    return h("div", { class: `sm-axis axis-${axis.axis}${hits < 2 ? " partial" : ""}` }, [
      h("span", { class: "sm-axis-name", text: axis.axis.toUpperCase() }),
      h("span", { class: "sm-arm neg", text: axis.negative ? formatLength(axis.negative.distance) : "open" }),
      h("span", { class: "sm-origin", title: "Picked surface" }),
      h("span", { class: "sm-arm pos", text: axis.positive ? formatLength(axis.positive.distance) : "open" }),
      h("b", { class: "sm-span", text: axis.span === null ? `${hits}/2 hits` : formatLength(axis.span) }),
    ]);
  };

  const paint = (): void => {
    root.replaceChildren();
    if (!ctx.session.model().loaded) {
      root.appendChild(emptyState("ruler", "No model loaded", "Open an IFC file to measure its retained surfaces."));
      return;
    }
    const local = ctx.local.status();
    const preciseAvailable = local.state === "available" && ctx.local.capabilities().includes("geometry.precise-distance");
    if (!preciseAvailable && precise) {
      precise = false;
      ctx.storage.write("precise", false);
    }
    const distanceValue = distance?.result.distance ?? null;
    const distancePass = distanceValue !== null && !distance?.result.intersecting && distanceValue * 1000 >= thresholdMm;
    const distanceResult = distance ? h("div", { class: `sm-reading ${distancePass ? "pass" : "fail"}` }, [
      h("span", { class: "sm-reading-kicker", text: distancePass ? "CLEARANCE PASSES" : "CLEARANCE CHECK" }),
      h("strong", { text: mm(distanceValue) }),
      h("span", { text: distanceValue === null ? "No geometry result" : `${thresholdMm} mm required  |  ${distance?.result.fidelity ?? "mesh"}` }),
    ]) : h("div", { class: "sm-reading empty" }, [
      h("span", { class: "sm-reading-kicker", text: "OBJECT GAP" }),
      h("strong", { text: "-" }),
      h("span", { text: "Set two elements, then measure" }),
    ]);
    const pair = h("div", { class: "sm-pair" }, [
      h("button", { class: "sm-slot", type: "button", title: "Use the selected element as A" }, [
        h("span", { text: "A" }), h("b", { text: label(a) }),
      ]),
      h("span", { class: "sm-pair-line" }),
      h("button", { class: "sm-slot", type: "button", title: "Use the selected element as B" }, [
        h("span", { text: "B" }), h("b", { text: label(b) }),
      ]),
    ]);
    pair.querySelectorAll("button")[0].addEventListener("click", () => setSlot("a"));
    pair.querySelectorAll("button")[1].addEventListener("click", () => setSlot("b"));

    const distanceControls = bar(
      button("Use 2 selected", setPairFromSelection),
      button(precise ? "Local precise" : "Browser mesh", () => {
        if (!preciseAvailable) return void ctx.feedback.toast("Connect Local Studio with the stored IFC source for a higher-precision IFC distance", "info");
        precise = !precise;
        ctx.storage.write("precise", precise);
        paint();
      }, precise ? "accent" : ""),
      field("Clearance", number(thresholdMm, (value) => {
        thresholdMm = Math.max(0, value);
        ctx.storage.write("thresholdMm", thresholdMm);
        paint();
      }, 5)),
      running === "distance" ? button("Stop", () => controller?.abort(), "warn") : button("Measure gap", () => void runDistance(), "accent"),
    );

    const pick = ctx.view.lastPick();
    const laserControls = bar(
      armed
        ? button("Cancel pick", () => { armed = false; paint(); }, "warn")
        : button("Pick surface", () => { armed = true; paint(); }, "accent"),
      button("Use last pick", () => void runLaser()),
      field("Range m", number(maxDistanceM, (value) => {
        maxDistanceM = Math.max(0.1, value);
        ctx.storage.write("maxDistanceM", maxDistanceM);
      }, 1, 0.1)),
      running === "laser" ? button("Stop", () => controller?.abort(), "warn") : "",
    );
    const axes = h("div", { class: "sm-axes" }, laser
      ? laser.axes.map(axisRow)
      : [h("div", { class: "sm-laser-empty", text: armed ? "Click the model where the laser should sit" : "No laser placed" })]);
    const laserActions = laser ? bar(
      button("Keep axes", keepLaser, "accent"),
      button("Face surface", alignSurface),
      button("Clear laser", () => { laser = null; clearLiveLaser(); paint(); }),
    ) : h("span");

    root.append(
      h("section", { class: "sm-instrument" }, [
        h("header", {}, [h("span", { text: "01" }), h("div", {}, [h("h3", { text: "Object gap" }), h("p", { text: "Shortest surface-to-surface witness" })])]),
        pair,
        distanceResult,
        distanceControls,
      ]),
      h("section", { class: `sm-instrument laser${armed ? " armed" : ""}` }, [
        h("header", {}, [h("span", { text: "02" }), h("div", {}, [h("h3", { text: "Axis laser" }), h("p", { text: "Next visible surface in six directions" })])]),
        laserControls,
        h("div", { class: "sm-pick-line" }, [
          h("span", { class: `sm-pick-dot${pick ? " ready" : ""}` }),
          h("span", { text: pick ? `Surface #${ctx.model.expressOf(pick.expressID)} at ${pick.point.map((value) => value.toFixed(2)).join(", ")}` : "Click a model surface to set the origin" }),
        ]),
        axes,
        laserActions,
      ]),
      hint("info", preciseAvailable
        ? "Browser mesh is the responsive default. A tighter native IFC tessellation is available through this trusted Local Studio session."
        : "Runs fully in this tab on retained mesh geometry. Local precise distance is available when Local Studio holds the IFC source."),
    );
  };

  ctx.events.on("selection", () => {
    if (armed && ctx.view.lastPick()) void runLaser();
    else paint();
  });
  ctx.events.on("service", paint);
  ctx.events.on("model", () => {
    generation += 1;
    controller?.abort();
    clearLiveLaser();
    if (resultHandle) ctx.results.dispose(resultHandle);
    a = null;
    b = null;
    distance = null;
    laser = null;
    resultHandle = "";
    armed = false;
    paint();
  });
  ctx.commands.register("smart-measure.open", () => paint());

  paint();
  host.appendChild(root);
  return {
    dispose: () => {
      controller?.abort();
      clearLiveLaser();
    },
  };
}
