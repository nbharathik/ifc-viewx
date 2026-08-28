import {
  button,
  centreOn,
  download,
  emptyState,
  h,
  header,
  icon,
  note,
  page,
  progress,
  readPointCloud,
  stats,
  toScene,
  type CloudPlacement,
  type ExtensionContext,
  type ExtensionInstance,
  type PointCloud,
} from "@ifcviewx/sdk";

const BANDS = [0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5];
const MAX_SCAN_BYTES = 256 * 1024 * 1024;

export function mount(host: HTMLElement, ctx: ExtensionContext): ExtensionInstance {
  let cloud: PointCloud | null = null;
  let placement: CloudPlacement = { offset: [0, 0, 0], rotation: 0, scale: 1, swapUp: true, exact: false };
  let scene: Float32Array | null = null;
  let deviation: Float32Array | null = null;
  const storedPointSize = ctx.storage.read<number>("pointSize", 0.035);
  const storedSearchRadius = ctx.storage.read<number>("searchRadius", 0.5);
  let pointSize = Number.isFinite(storedPointSize) ? Math.max(0.001, Math.min(1, storedPointSize)) : 0.035;
  let searchRadius = Number.isFinite(storedSearchRadius) ? Math.max(0.01, Math.min(1_000, storedSearchRadius)) : 0.5;
  let controller: AbortController | null = null;
  let loadGeneration = 0;
  let loading = false;
  let visible = true;
  let disposed = false;
  let needsPlacement = false;
  let loadError = "";
  let measureError = "";

  const status = progress();
  const file = h("input", {
    type: "file",
    class: "hidden",
    accept: ".las,.xyz,.pts,.txt,.asc,.csv",
    "aria-label": "Open point cloud",
  });
  const root = page();
  root.classList.add("point-cloud-panel");
  host.appendChild(root);

  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    file.value = "";
    if (chosen) void load(chosen);
  });

  const load = async (chosen: File): Promise<void> => {
    const generation = ++loadGeneration;
    loading = true;
    loadError = "";
    measureError = "";
    status.set(0, 1, `Reading ${chosen.name}`);
    paint();
    try {
      if (chosen.size > MAX_SCAN_BYTES) {
        throw new Error("This scan is larger than the 256 MB browser limit. Decimate or convert it before opening.");
      }
      const bytes = new Uint8Array(await chosen.arrayBuffer());
      if (disposed || ctx.signal.aborted || generation !== loadGeneration) return;
      const next = readPointCloud(chosen.name, bytes, { signal: ctx.signal });
      if (disposed || ctx.signal.aborted || generation !== loadGeneration) return;
      cloud = next;
      placement.swapUp = next.upAxis === "z";
      deviation = null;
      visible = true;
      place();
      ctx.feedback.log(
        `${chosen.name}: ${(next.positions.length / 3).toLocaleString()} of ${next.total.toLocaleString()} points loaded`,
        "success",
      );
    } catch (error) {
      if (!disposed && !ctx.signal.aborted && (error as Error).name !== "AbortError") {
        loadError = error instanceof Error ? error.message : String(error);
        ctx.feedback.toast(loadError, "error");
      }
    } finally {
      if (!disposed && generation === loadGeneration) {
        loading = false;
        status.hide();
        paint();
      }
    }
  };

  const place = (): void => {
    if (!cloud) return;
    const box = ctx.view.modelBox();
    const exact = placement.swapUp ? tryGeoreference(ctx, cloud) : null;
    if (!exact && !box) {
      scene = null;
      needsPlacement = true;
      ctx.view.setPointCloud(null);
      paint();
      return;
    }
    placement = exact ?? centreOn(cloud, box!, placement.swapUp);
    needsPlacement = false;
    project();
  };

  const project = (): void => {
    if (!cloud) return;
    controller?.abort();
    deviation = null;
    measureError = "";
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
    paint();
  };

  const draw = (): void => {
    if (!scene) return void ctx.view.setPointCloud(null);
    ctx.view.setPointCloud(scene, colorsFor(), pointSize);
    ctx.view.setPointCloudVisible(visible);
  };

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
      const color = Number.isFinite(value) ? rampColor(value) : [0.35, 0.35, 0.4];
      out[index * 3] = color[0];
      out[index * 3 + 1] = color[1];
      out[index * 3 + 2] = color[2];
    }
    return out;
  };

  const measure = async (): Promise<void> => {
    if (controller) {
      controller.abort();
      return;
    }
    if (!scene || !cloud) return void ctx.feedback.toast("Open and align a scan first", "info");
    if (!ctx.session.model().loaded) return void ctx.feedback.toast("Open an IFC model before comparing", "info");
    controller = new AbortController();
    const runController = controller;
    const measuredScene = scene;
    measureError = "";
    status.set(0, 1, `Comparing ${(scene.length / 3).toLocaleString()} points`);
    paint();
    try {
      const result = await ctx.geometry.deviation(Float64Array.from(scene), {
        maxDistance: searchRadius,
        signal: runController.signal,
      });
      if (disposed || runController.signal.aborted || controller !== runController || scene !== measuredScene) return;
      if (result.distances.length !== scene.length / 3) throw new Error("The comparison returned an incomplete result.");
      deviation = result.distances;
      draw();
      ctx.feedback.log(
        `${result.measured.toLocaleString()} of ${result.points.toLocaleString()} points matched within ${searchRadius} m`,
        "success",
      );
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        measureError = error instanceof Error ? error.message : String(error);
        ctx.feedback.toast(measureError, "error");
      }
    } finally {
      if (controller === runController) controller = null;
      status.hide();
      paint();
    }
  };

  const numberField = (
    label: string,
    value: number,
    step: number,
    onChange: (next: number) => void,
  ): HTMLElement => {
    const input = h("input", { type: "number", class: "plug-num", value: String(value), step: String(step) });
    input.addEventListener("change", () => {
      const next = Number(input.value);
      if (!Number.isFinite(next)) input.value = String(value);
      else onChange(next);
    });
    return h("label", { class: "cloud-field" }, [h("span", { text: label }), input]);
  };

  const workflow = (): HTMLElement => {
    const aligned = Boolean(scene && !needsPlacement);
    const compared = Boolean(deviation);
    const current = !cloud ? 0 : !aligned ? 1 : 2;
    const stages: Array<[string, string, boolean]> = [
      ["Import", cloud?.name ?? "LAS or XYZ", Boolean(cloud)],
      ["Align", aligned ? (placement.exact ? "Georeferenced" : "Placed") : "Needs model", aligned],
      ["Compare", compared ? "Result ready" : "Deviation", compared],
    ];
    return h("ol", { class: "cloud-workflow", "aria-label": "Point cloud workflow" }, stages.map(([label, detail, done], index) =>
      h("li", { class: `cloud-stage${done ? " done" : ""}${index === current ? " current" : ""}` }, [
        h("span", { class: "cloud-stage-index", text: String(index + 1) }),
        h("span", { class: "cloud-stage-copy" }, [h("b", { text: label }), h("small", { text: detail })]),
      ]),
    ));
  };

  const alignmentPanel = (): HTMLElement => {
    const axis = h("select", { class: "plug-select", "aria-label": "Scan up axis" }, [
      h("option", { value: "z", text: "Z-up survey" }),
      h("option", { value: "y", text: "Y-up model" }),
    ]);
    axis.value = placement.swapUp ? "z" : "y";
    axis.addEventListener("change", () => {
      placement.swapUp = axis.value === "z";
      placement.exact = false;
      place();
    });
    return h("details", { class: "cloud-settings", open: needsPlacement }, [
      h("summary", {}, [
        h("span", {}, [icon("sliders", 13), h("b", { text: "Alignment and tolerance" })]),
        h("small", { text: placement.exact ? "Model georeference" : "Manual placement" }),
      ]),
      h("div", { class: "cloud-settings-body" }, [
        h("label", { class: "cloud-field cloud-axis" }, [h("span", { text: "Coordinate convention" }), axis]),
        h("div", { class: "cloud-placement-grid" }, [
          numberField("East offset, m", placement.offset[0], 0.1, (value) => { placement.offset[0] = value; project(); }),
          numberField("Up offset, m", placement.offset[1], 0.1, (value) => { placement.offset[1] = value; project(); }),
          numberField("North offset, m", placement.offset[2], 0.1, (value) => { placement.offset[2] = value; project(); }),
          numberField("Rotation, deg", (placement.rotation * 180) / Math.PI, 1, (value) => {
            placement.rotation = (value * Math.PI) / 180;
            project();
          }),
          numberField("Scale", placement.scale, 0.01, (value) => {
            placement.scale = Math.max(1e-6, Math.min(1e6, value));
            project();
          }),
          numberField("Point size, m", pointSize, 0.005, (value) => {
            pointSize = Math.max(0.001, Math.min(1, value));
            ctx.storage.write("pointSize", pointSize);
            ctx.view.setPointCloudSize(pointSize);
          }),
          numberField("Search radius, m", searchRadius, 0.05, (value) => {
            searchRadius = Math.max(0.01, Math.min(1_000, value));
            ctx.storage.write("searchRadius", searchRadius);
            controller?.abort();
            deviation = null;
            draw();
            paint();
          }),
        ]),
      ]),
    ]);
  };

  const resultPanel = (): HTMLElement => {
    if (!deviation) {
      return note(needsPlacement
        ? "Open an IFC model, then align the scan before comparing."
        : "The scan is ready. Adjust alignment if needed, then compare it with the model surface.");
    }
    const finite = [...deviation].filter(Number.isFinite);
    if (!finite.length) return note(`No point matched a model surface within ${searchRadius} m. Check alignment or increase the search radius.`);
    const measured = Float32Array.from(finite).sort();
    const bandCounts = new Uint32Array(BANDS.length + 1);
    for (const value of measured) {
      let band = 0;
      while (band < BANDS.length && value > BANDS[band]) band += 1;
      bandCounts[band] += 1;
    }
    const percentile = (fraction: number): number => measured[Math.min(measured.length - 1, Math.floor(measured.length * fraction))];
    const histogram = h("div", { class: "cloud-bands", "aria-label": "Deviation distribution" });
    let previous = 0;
    BANDS.forEach((band, index) => {
      const count = bandCounts[index];
      const share = count / measured.length;
      histogram.appendChild(h("div", { class: "cloud-band", title: `${count.toLocaleString()} points` }, [
        h("div", { class: "cloud-band-label" }, [
          h("span", { text: `${(previous * 1000).toFixed(0)} to ${(band * 1000).toFixed(0)} mm` }),
          h("b", { text: `${(share * 100).toFixed(1)}%` }),
        ]),
        h("span", { class: "cloud-band-track" }, [
          h("i", { style: `width:${Math.max(1, share * 100)}%;background:${cssRamp(band)}` }),
        ]),
      ]));
      previous = band;
    });
    const beyond = bandCounts[BANDS.length];
    return h("section", { class: "cloud-result" }, [
      h("div", { class: "cloud-section-title" }, [
        h("span", {}, [h("i", { class: "cloud-signal" }), h("b", { text: "Surface deviation" })]),
        h("small", { text: `${measured.length.toLocaleString()} points measured` }),
      ]),
      stats([
        ["Median", `${(percentile(0.5) * 1000).toFixed(0)} mm`],
        ["95th percentile", `${(percentile(0.95) * 1000).toFixed(0)} mm`, percentile(0.95) > 0.05 ? "warn" : "ok"],
        ["Worst", `${(measured[measured.length - 1] * 1000).toFixed(0)} mm`],
        ["No nearby surface", (deviation.length - measured.length).toLocaleString()],
      ]),
      histogram,
      ...(beyond ? [note(`${beyond.toLocaleString()} points are more than ${(previous * 1000).toFixed(0)} mm from the model.`)] : []),
    ]);
  };

  const exportCsv = (): void => {
    if (!scene || !deviation) return void ctx.feedback.toast("Compare the scan before exporting", "info");
    const chunks: BlobPart[] = ["\uFEFFX,Y,Z,Deviation m\r\n"];
    let part = "";
    for (let index = 0; index < deviation.length; index++) {
      part += `${scene[index * 3].toFixed(4)},${scene[index * 3 + 1].toFixed(4)},${scene[index * 3 + 2].toFixed(4)},` +
        `${Number.isFinite(deviation[index]) ? deviation[index].toFixed(5) : ""}\r\n`;
      if (index % 10_000 === 9) {
        chunks.push(part);
        part = "";
      }
    }
    if (part) chunks.push(part);
    download(`deviation-${cloud?.name ?? "scan"}.csv`, new Blob(chunks, { type: "text/csv;charset=utf-8" }), "text/csv;charset=utf-8");
  };

  const actionMenu = (): HTMLElement => {
    const action = (name: string, label: string, run: () => void, disabled = false): HTMLButtonElement => {
      const node = h("button", { type: "button", disabled }, [icon(name, 13), h("span", { text: label })]);
      node.addEventListener("click", run);
      return node;
    };
    return h("details", { class: "cloud-action-menu" }, [
      h("summary", { class: "btn sm" }, [icon("settings", 13), h("span", { text: "Options" })]),
      h("div", { class: "cloud-action-menu-body" }, [
        action(visible ? "eye-off" : "eye", visible ? "Hide scan" : "Show scan", () => {
          visible = !visible;
          ctx.view.setPointCloudVisible(visible);
          paint();
        }),
        action("refresh", "Reset alignment", place, !ctx.session.model().loaded),
        action("download", "Export deviation CSV", exportCsv, !deviation),
        action("trash", "Remove scan", () => {
          controller?.abort();
          cloud = null;
          scene = null;
          deviation = null;
          visible = true;
          needsPlacement = false;
          loadError = "";
          measureError = "";
          ctx.view.setPointCloud(null);
          paint();
        }),
      ]),
    ]);
  };

  function paint(): void {
    const errors = [loadError, measureError].filter(Boolean);
    const modelReady = ctx.session.model().loaded;
    const compareButton = button(controller ? "Stop comparison" : deviation ? "Compare again" : "Compare with model", () => void measure(), "accent");
    compareButton.disabled = loading || !scene || !modelReady;
    const replaceButton = button("Replace scan", () => file.click());
    replaceButton.disabled = loading;

    root.replaceChildren(
      header("Point cloud", "Align an as-built scan and measure it against the model surface.", "LOCAL"),
      workflow(),
      ...errors.map((message) => h("div", { class: "cloud-error", role: "alert" }, [icon("alert", 14), h("span", { text: message })])),
      status.root,
      ...(!cloud ? [
        h("section", { class: "cloud-empty" }, [
          emptyState("cube", "No scan open", "Use an uncompressed LAS file or a text export with X Y Z columns."),
          button(loading ? "Opening scan" : "Open scan", () => file.click(), "accent"),
          h("small", { text: "LAS, XYZ, PTS, TXT, ASC or CSV up to 256 MB" }),
        ]),
      ] : [
        h("section", { class: "cloud-scan-card" }, [
          h("div", { class: "cloud-scan-head" }, [
            h("span", { class: "cloud-file-icon" }, [icon("cube", 16)]),
            h("span", { class: "grow" }, [
              h("b", { text: cloud.name, title: cloud.name }),
              h("small", { text: `${cloud.format} / ${(cloud.positions.length / 3).toLocaleString()} points displayed` }),
            ]),
            h("span", { class: `cloud-visibility${visible ? " on" : ""}`, text: visible ? "Visible" : "Hidden" }),
          ]),
          h("div", { class: "cloud-primary-actions" }, [compareButton, replaceButton, actionMenu()]),
        ]),
        alignmentPanel(),
        resultPanel(),
      ]),
      file,
    );
  }

  paint();

  const off = ctx.events.on("model", () => {
    controller?.abort();
    deviation = null;
    scene = null;
    needsPlacement = cloud !== null;
    measureError = "";
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
