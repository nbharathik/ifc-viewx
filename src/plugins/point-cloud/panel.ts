// The scan, over the model, coloured by how far apart they are.
//
// Two jobs. Placing the scan is the fiddly one and is done with real numbers
// rather than by dragging: georeferencing where the file has it, a centred
// start and a nudge where it does not. Measuring is the valuable one, and it
// asks the same BVHs the clash engine uses, so the distances are triangle
// distances rather than a voxel approximation.
import {
  bar,
  button,
  centreOn,
  download,
  emptyState,
  h,
  header,
  hint,
  note,
  page,
  progress,
  readPointCloud,
  stats,
  toast,
  toScene,
  type CloudPlacement,
  type ExtensionContext,
  type ExtensionInstance,
  type PointCloud,
} from "@ifcviewx/sdk";

/** Bands the deviation colour ramp uses, in metres. */
const BANDS = [0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5];
const MAX_SCAN_BYTES = 256 * 1024 * 1024;

export function mount(host: HTMLElement, ctx: ExtensionContext): ExtensionInstance {
  let cloud: PointCloud | null = null;
  let placement: CloudPlacement = { offset: [0, 0, 0], rotation: 0, scale: 1, swapUp: true, exact: false };
  let scene: Float32Array | null = null;
  let deviation: Float32Array | null = null;
  const storedPointSize = ctx.storage.read<number>("pointSize", 0.02);
  const storedSearchRadius = ctx.storage.read<number>("searchRadius", 0.5);
  let pointSize = Number.isFinite(storedPointSize) ? Math.max(0.001, Math.min(1, storedPointSize)) : 0.02;
  let searchRadius = Number.isFinite(storedSearchRadius) ? Math.max(0.01, Math.min(1_000, storedSearchRadius)) : 0.5;
  let controller: AbortController | null = null;
  let loadGeneration = 0;
  let disposed = false;
  let needsPlacement = false;

  const status = progress();
  const summary = h("div");
  const detail = h("div", { class: "cloud-detail" });
  const controls = h("div", { class: "sun-controls" });
  const file = h("input", { type: "file", class: "hidden", accept: ".las,.laz,.xyz,.pts,.txt,.asc,.csv" });

  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    file.value = "";
    if (chosen) void load(chosen);
  });

  const load = async (chosen: File): Promise<void> => {
    const generation = ++loadGeneration;
    status.set(0, 1, `Reading ${chosen.name}`);
    try {
      if (chosen.size > MAX_SCAN_BYTES) {
        throw new Error("That scan exceeds the 256 MB in-browser limit. Convert or decimate it in Local Studio first.");
      }
      const bytes = new Uint8Array(await chosen.arrayBuffer());
      if (disposed || ctx.signal.aborted || generation !== loadGeneration) return;
      cloud = readPointCloud(chosen.name, bytes, { signal: ctx.signal });
      if (disposed || ctx.signal.aborted || generation !== loadGeneration) return;
      deviation = null;
      place();
      ctx.feedback.log(
        `${chosen.name}: ${cloud.positions.length / 3} of ${cloud.total.toLocaleString()} points kept (${cloud.format})`,
        "success",
      );
    } catch (error) {
      if (!disposed && !ctx.signal.aborted && (error as Error).name !== "AbortError") {
        ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
      }
    } finally {
      if (!disposed && generation === loadGeneration) {
        status.hide();
        paint();
      }
    }
  };

  /**
   * Put the scan where the model is. A georeferenced model can place it
   * exactly, because a survey and a projected CRS are the same frame; without
   * one the scan is centred on the model and the offset is there to nudge.
   */
  const place = (): void => {
    if (!cloud) return;
    const box = ctx.view.modelBox();
    const exact = tryGeoreference(ctx, cloud);
    if (!exact && !box) {
      scene = null;
      needsPlacement = true;
      ctx.view.setPointCloud(null);
      paint();
      return;
    }
    placement = exact ?? centreOn(cloud, box!);
    needsPlacement = false;
    project();
  };

  const project = (): void => {
    if (!cloud) return;
    // A placement edit changes every query point, so distances from the old
    // placement are no longer meaningful and an in-flight query is obsolete.
    controller?.abort();
    deviation = null;
    const count = cloud.positions.length / 3;
    const out = new Float32Array(count * 3);
    for (let index = 0; index < count; index++) {
      const at = toScene(
        [cloud.positions[index * 3], cloud.positions[index * 3 + 1], cloud.positions[index * 3 + 2]],
        placement,
      );
      out[index * 3] = at[0];
      out[index * 3 + 1] = at[1];
      out[index * 3 + 2] = at[2];
    }
    scene = out;
    draw();
  };

  const draw = (): void => {
    if (!scene) return void ctx.view.setPointCloud(null);
    ctx.view.setPointCloud(scene, colorsFor(), pointSize);
  };

  /** Scan colour, or the deviation ramp once it has been measured. */
  const colorsFor = (): Float32Array | null => {
    if (!cloud || !scene) return null;
    const count = scene.length / 3;
    if (!deviation) {
      if (cloud.colors && cloud.colors.length === scene.length) return cloud.colors;
      if (cloud.intensity) {
        const out = new Float32Array(count * 3);
        for (let index = 0; index < count; index++) {
          const value = 0.35 + cloud.intensity[index] * 0.65;
          out[index * 3] = value;
          out[index * 3 + 1] = value;
          out[index * 3 + 2] = value;
        }
        return out;
      }
      return null;
    }
    const out = new Float32Array(count * 3);
    for (let index = 0; index < count; index++) {
      const value = deviation[index];
      const color = Number.isNaN(value) ? [0.35, 0.35, 0.4] : rampColor(value);
      out[index * 3] = color[0];
      out[index * 3 + 1] = color[1];
      out[index * 3 + 2] = color[2];
    }
    return out;
  };

  const measure = async (): Promise<void> => {
    if (!scene || !cloud) return void toast("Load a scan first", "info");
    if (!ctx.session.model().loaded) return void toast("Open the model to compare against", "info");
    if (controller) {
      controller.abort();
      return;
    }
    controller = new AbortController();
    const runController = controller;
    const measuredScene = scene;
    measureButton.textContent = "Stop";
    status.set(0, 1, `Measuring ${(scene.length / 3).toLocaleString()} points against the model`);
    try {
      const result = await ctx.geometry.deviation(Float64Array.from(scene), {
        maxDistance: searchRadius,
        signal: controller.signal,
      });
      if (disposed || runController.signal.aborted || controller !== runController || scene !== measuredScene) return;
      deviation = result.distances;
      draw();
      paint();
      ctx.feedback.log(
        `${result.measured.toLocaleString()} of ${result.points.toLocaleString()} points found a surface within ${searchRadius} m`,
        "success",
      );
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
      }
    } finally {
      if (controller === runController) controller = null;
      measureButton.textContent = "Measure deviation";
      status.hide();
    }
  };

  const measureButton = button("Measure deviation", () => void measure(), "accent");

  const paint = (): void => {
    if (!cloud) {
      summary.replaceChildren();
      detail.replaceChildren(
        emptyState("cube", "No scan loaded", "Open a LAS or an X Y Z export. LAZ and E57 convert in Local Studio."),
      );
      controls.replaceChildren();
      return;
    }
    const kept = cloud.positions.length / 3;
    summary.replaceChildren(stats([
      ["points kept", kept.toLocaleString()],
      ["in the file", cloud.total.toLocaleString()],
      ["placement", placement.exact ? "georeferenced" : "centred", placement.exact ? "ok" : "warn"],
      ["format", cloud.format],
    ]));

    const numberField = (label: string, value: number, step: number, onChange: (next: number) => void): HTMLElement => {
      const input = h("input", { type: "number", class: "plug-num", value: String(value), step: String(step) });
      input.addEventListener("change", () => {
        const next = Number(input.value);
        if (!Number.isFinite(next)) input.value = String(value);
        else onChange(next);
      });
      return h("label", { class: "plug-field" }, [h("span", { text: label }), input]);
    };

    controls.replaceChildren(
      numberField("east m", placement.offset[0], 0.1, (value) => {
        placement.offset[0] = value;
        project();
      }),
      numberField("up m", placement.offset[1], 0.1, (value) => {
        placement.offset[1] = value;
        project();
      }),
      numberField("north m", placement.offset[2], 0.1, (value) => {
        placement.offset[2] = value;
        project();
      }),
      numberField("rotate °", (placement.rotation * 180) / Math.PI, 1, (value) => {
        placement.rotation = (value * Math.PI) / 180;
        project();
      }),
      numberField("scale", placement.scale, 0.01, (value) => {
        placement.scale = Math.max(1e-6, Math.min(1e6, value));
        project();
      }),
      numberField("point m", pointSize, 0.005, (value) => {
        pointSize = Math.max(0.001, Math.min(1, value));
        ctx.storage.write("pointSize", pointSize);
        ctx.view.setPointCloudSize(pointSize);
      }),
      numberField("search m", searchRadius, 0.05, (value) => {
        searchRadius = Math.max(0.01, Math.min(1_000, value));
        ctx.storage.write("searchRadius", searchRadius);
        controller?.abort();
        deviation = null;
        draw();
        paint();
      }),
    );

    if (!deviation) {
      detail.replaceChildren(note(needsPlacement
        ? "The model changed, so the old scan placement was cleared. Re-place it before measuring."
        : "Place the scan, then measure. Every point is compared with the nearest triangle in the model."));
      return;
    }
    let measuredCount = 0;
    for (const value of deviation) if (Number.isFinite(value)) measuredCount += 1;
    if (measuredCount === 0) {
      detail.replaceChildren(note(`No point found a surface within ${searchRadius} m. Check the placement, or widen the search.`));
      return;
    }
    const measured = new Float32Array(measuredCount);
    const bandCounts = new Uint32Array(BANDS.length + 1);
    let measuredAt = 0;
    for (const value of deviation) {
      if (!Number.isFinite(value)) continue;
      measured[measuredAt++] = value;
      let band = 0;
      while (band < BANDS.length && value > BANDS[band]) band += 1;
      bandCounts[band] += 1;
    }
    measured.sort();
    const percentile = (fraction: number): number => measured[Math.min(measured.length - 1, Math.floor(measured.length * fraction))];
    const histogram = h("div", { class: "cloud-bands" });
    let previous = 0;
    for (const band of BANDS) {
      const inBand = bandCounts[BANDS.indexOf(band)];
      const share = inBand / measured.length;
      histogram.appendChild(
        h("div", { class: "cloud-band", title: `${inBand.toLocaleString()} points` }, [
          h("span", { class: "cloud-swatch", style: `background:${cssRamp(band)}` }),
          h("span", { class: "grow", text: `${(previous * 1000).toFixed(0)} to ${(band * 1000).toFixed(0)} mm` }),
          h("b", { text: `${(share * 100).toFixed(1)}%` }),
        ]),
      );
      previous = band;
    }
    const beyond = bandCounts[BANDS.length];
    detail.replaceChildren(
      stats([
        ["measured", measuredCount.toLocaleString()],
        ["median", `${(percentile(0.5) * 1000).toFixed(0)} mm`],
        ["95th", `${(percentile(0.95) * 1000).toFixed(0)} mm`, percentile(0.95) > 0.05 ? "warn" : "ok"],
        ["worst", `${(measured[measured.length - 1] * 1000).toFixed(0)} mm`],
        ["no surface near", (deviation.length - measuredCount).toLocaleString()],
      ]),
      histogram,
      ...(beyond
        ? [note(`${beyond.toLocaleString()} points are further than ${(previous * 1000).toFixed(0)} mm from anything in the model.`)]
        : []),
    );
  };

  const exportCsv = (): void => {
    if (!scene || !deviation) return void toast("Measure first", "info");
    const chunks: BlobPart[] = ["\uFEFFX,Y,Z,Deviation m\r\n"];
    let part = "";
    for (let index = 0; index < deviation.length; index++) {
      part += `${scene[index * 3].toFixed(4)},${scene[index * 3 + 1].toFixed(4)},${scene[index * 3 + 2].toFixed(4)},` +
        `${Number.isNaN(deviation[index]) ? "" : deviation[index].toFixed(5)}\r\n`;
      if (index % 10_000 === 9) {
        chunks.push(part);
        part = "";
      }
    }
    if (part) chunks.push(part);
    download(`deviation-${cloud?.name ?? "scan"}.csv`, new Blob(chunks, { type: "text/csv;charset=utf-8" }), "text/csv;charset=utf-8");
  };

  const root = page(
    header("Point cloud", "The as-built scan over the model, coloured by how far apart they are."),
    bar(
      button("Open scan", () => file.click(), "accent"),
      measureButton,
      button("Re-place", () => place()),
      button("Hide scan", () => ctx.view.setPointCloudVisible(false)),
      button("Show scan", () => ctx.view.setPointCloudVisible(true)),
      button("Clear", () => {
        controller?.abort();
        cloud = null;
        scene = null;
        deviation = null;
        ctx.view.setPointCloud(null);
        paint();
      }),
      button("CSV", () => exportCsv()),
    ),
    hint("cube", "Uncompressed LAS and plain X Y Z read here. LAZ and E57 are conversions rather than readers and belong in Local Studio, which is also on this machine."),
    status.root,
    summary,
    controls,
    detail,
    file,
  );

  host.appendChild(root);
  paint();

  const off = ctx.events.on("model", () => {
    controller?.abort();
    deviation = null;
    scene = null;
    needsPlacement = cloud !== null;
    ctx.view.setPointCloud(null);
    paint();
  });

  return {
    dispose: () => {
      disposed = true;
      loadGeneration += 1;
      controller?.abort();
      off();
      ctx.view.setPointCloud(null);
    },
  };
}

/**
 * A georeferenced model and a survey are the same frame, so the scan can be
 * placed exactly rather than nudged. The viewer answers the mapping; this
 * only has to ask it for two points and read the transform back out of them.
 */
function tryGeoreference(ctx: ExtensionContext, cloud: PointCloud): CloudPlacement | null {
  const models = ctx.view.models();
  const anchor = models.find((model) => model.geo?.projectedCrs);
  if (!anchor) return null;
  const origin = ctx.view.georeferencedToScene([cloud.min[0], cloud.min[1], cloud.min[2]]);
  const east = ctx.view.georeferencedToScene([cloud.min[0] + 100, cloud.min[1], cloud.min[2]]);
  if (!origin || !east) return null;
  const dx = east[0] - origin[0];
  const dz = east[2] - origin[2];
  const scale = Math.hypot(dx, dz) / 100;
  const rotation = Math.atan2(dz, dx);
  const base: CloudPlacement = { offset: [0, 0, 0], rotation, scale: scale || 1, swapUp: true, exact: true };
  const placed = toScene([cloud.min[0], cloud.min[1], cloud.min[2]], base);
  return {
    ...base,
    offset: [origin[0] - placed[0], origin[1] - placed[1], origin[2] - placed[2]],
  };
}

/** Green through amber to red, with the bands the histogram uses. */
function rampColor(metres: number): [number, number, number] {
  const t = Math.min(1, metres / 0.1);
  if (t < 0.5) {
    const k = t / 0.5;
    return [0.25 + k * 0.7, 0.75, 0.35 - k * 0.2];
  }
  const k = (t - 0.5) / 0.5;
  return [0.95, 0.75 - k * 0.55, 0.15];
}

function cssRamp(metres: number): string {
  const [r, g, b] = rampColor(metres);
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}
