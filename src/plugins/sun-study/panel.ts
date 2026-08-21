// Sun and shadow.
//
// Two things, and they answer different questions. The light shows what the
// building looks like at a moment; the accumulation says how many hours a
// surface actually sees the sun across a day, which is the number a planning
// submission is arguing about. The second is ray cast against the real mesh,
// not read off a shadow map, so it is a number rather than an impression.
import {
  bar,
  button,
  dayArc,
  emptyState,
  formatNumber,
  h,
  header,
  hint,
  note,
  page,
  progress,
  saveCsv,
  select,
  stats,
  siteLocalInstant,
  sunDirection,
  sunPosition,
  toast,
  type ExtensionContext,
  type ExtensionInstance,
  type SunSample,
} from "@ifcviewx/sdk";

type Mode = "site" | "selection";

interface Settings {
  latitude: number;
  longitude: number;
  date: string;
  minutes: number;
  northOffset: number;
  /** Explicit site civil-time offset; never borrow the reviewing browser's zone. */
  utcOffsetMinutes: number;
  stepMinutes: number;
  gridMetres: number;
  height: number;
  mode: Mode;
}

const DEFAULTS: Settings = {
  latitude: 54.09,
  longitude: 12.13,
  date: "2026-06-21",
  minutes: 12 * 60,
  northOffset: 0,
  utcOffsetMinutes: 120,
  stepMinutes: 30,
  gridMetres: 2,
  height: 0,
  mode: "site",
};

/** A whole-day run over a fine grid is minutes of work; this keeps it honest. */
const MAX_SAMPLES = 1200;

export function mount(host: HTMLElement, ctx: ExtensionContext): ExtensionInstance {
  const settings = sanitizeSettings(ctx.storage.read<Partial<Settings>>("settings", {}));
  let exposure: Array<{ sample: SunSample; hours: number; id?: number }> = [];
  let running = false;
  let controller: AbortController | null = null;

  const status = progress();
  const readout = h("div");
  const map = h("div", { class: "sun-map" });
  const summary = h("div");

  const store = (): void => ctx.storage.write("settings", settings);

  const momentOf = (): Date => {
    const [year, month, day] = settings.date.split("-").map(Number);
    return siteLocalInstant(year || 2026, month || 1, day || 1, settings.minutes, settings.utcOffsetMinutes);
  };

  const applyLight = (): void => {
    const position = sunPosition(momentOf(), settings.latitude, settings.longitude);
    ctx.view.setSun(position.up ? sunDirection(position, settings.northOffset) : null);
    const hours = Math.floor(settings.minutes / 60);
    const mins = String(Math.round(settings.minutes % 60)).padStart(2, "0");
    readout.replaceChildren(stats([
      ["time", `${String(hours).padStart(2, "0")}:${mins}`],
      ["site UTC", `${settings.utcOffsetMinutes >= 0 ? "+" : ""}${formatNumber(settings.utcOffsetMinutes / 60)}`],
      ["altitude", `${position.altitude.toFixed(1)}°`, position.up ? "ok" : "warn"],
      ["azimuth", `${position.azimuth.toFixed(1)}°`],
      ["state", position.up ? "sun up" : "below horizon", position.up ? "ok" : "warn"],
    ]));
  };

  /** Sun directions across the day, one per step, skipping the night. */
  const dayDirections = (): Array<[number, number, number]> =>
    dayArc(momentOf(), settings.latitude, settings.longitude, settings.stepMinutes, settings.utcOffsetMinutes)
      .filter((entry) => entry.position.up)
      .map((entry) => sunDirection(entry.position, settings.northOffset));

  /**
   * Sample points. A site study grids a horizontal plane over the model's own
   * extent; a selection study takes the top face of each selected element,
   * which is the surface somebody arguing about daylight actually means.
   */
  const samplesOf = (): Array<{ sample: SunSample; id?: number }> => {
    if (settings.mode === "selection") {
      const ids = ctx.view.selection();
      if (ids.length === 0) return [];
      const out: Array<{ sample: SunSample; id?: number }> = [];
      for (const id of ids.slice(0, MAX_SAMPLES)) {
        const bounds = ctx.model.bounds(id);
        if (!bounds) continue;
        out.push({
          id,
          sample: {
            point: [
              (bounds.min.x + bounds.max.x) / 2,
              bounds.max.y,
              (bounds.min.z + bounds.max.z) / 2,
            ],
            normal: [0, 1, 0],
          },
        });
      }
      return out;
    }
    const box = ctx.view.modelBox();
    if (!box) return [];
    const step = Math.max(0.25, settings.gridMetres);
    const height = box.min[1] + settings.height;
    const out: Array<{ sample: SunSample; id?: number }> = [];
    const nx = Math.max(1, Math.floor((box.max[0] - box.min[0]) / step) + 1);
    const nz = Math.max(1, Math.floor((box.max[2] - box.min[2]) / step) + 1);
    const targetX = nx * nz <= MAX_SAMPLES ? nx : Math.max(1, Math.floor(Math.sqrt(MAX_SAMPLES * nx / nz)));
    const targetZ = nx * nz <= MAX_SAMPLES ? nz : Math.max(1, Math.floor(MAX_SAMPLES / targetX));
    for (let ix = 0; ix < targetX; ix++) {
      const x = targetX === 1 ? (box.min[0] + box.max[0]) / 2 : box.min[0] + (box.max[0] - box.min[0]) * ix / (targetX - 1);
      for (let iz = 0; iz < targetZ; iz++) {
        const z = targetZ === 1 ? (box.min[2] + box.max[2]) / 2 : box.min[2] + (box.max[2] - box.min[2]) * iz / (targetZ - 1);
        out.push({ sample: { point: [x, height, z], normal: [0, 1, 0] } });
      }
    }
    return out;
  };

  const run = async (): Promise<void> => {
    if (running) {
      controller?.abort();
      return;
    }
    if (!ctx.session.model().loaded) return void toast("Open a model first", "info");
    const samples = samplesOf();
    if (samples.length === 0) {
      toast(settings.mode === "selection" ? "Select the surfaces to study first" : "No model extent to grid", "info");
      return;
    }
    const directions = dayDirections();
    if (directions.length === 0) {
      toast("The sun never rises at that latitude on that date", "info");
      return;
    }
    running = true;
    controller = new AbortController();
    runButton.textContent = "Stop";
    status.set(0, 1, `Casting ${(samples.length * directions.length).toLocaleString()} rays`);
    try {
      const result = await ctx.geometry.sun(
        samples.map((entry) => entry.sample),
        directions,
        settings.stepMinutes,
        { signal: controller.signal },
      );
      exposure = samples.map((entry, index) => ({ ...entry, hours: result.exposure[index] ?? 0 }));
      paintResult(result.directions);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
      }
    } finally {
      running = false;
      controller = null;
      runButton.textContent = "Run day study";
      status.hide();
    }
  };

  const paintResult = (directions: number): void => {
    if (exposure.length === 0) {
      summary.replaceChildren();
      map.replaceChildren(emptyState("globe", "Nothing measured yet", "Pick a date and a surface, then run the day."));
      return;
    }
    const hours = exposure.map((entry) => entry.hours);
    const best = Math.max(...hours);
    const worst = Math.min(...hours);
    const mean = hours.reduce((total, value) => total + value, 0) / hours.length;
    summary.replaceChildren(stats([
      ["samples", exposure.length.toLocaleString()],
      ["sun steps", directions.toLocaleString()],
      ["max hours", formatNumber(best), "ok"],
      ["mean hours", formatNumber(mean)],
      ["min hours", formatNumber(worst), worst === 0 ? "warn" : undefined],
    ]));

    // A plan-view heat map: the study is about a horizontal surface, so this
    // is the drawing somebody would put in the submission anyway.
    const xs = exposure.map((entry) => entry.sample.point[0]);
    const zs = exposure.map((entry) => entry.sample.point[2]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const width = Math.max(1e-6, maxX - minX);
    const depth = Math.max(1e-6, maxZ - minZ);
    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("class", "sun-heat");
    const cell = Math.max(1.2, 100 / Math.sqrt(exposure.length) / 1.4);
    for (const entry of exposure) {
      const rect = document.createElementNS(svgNs, "rect");
      rect.setAttribute("x", String(((entry.sample.point[0] - minX) / width) * 100 - cell / 2));
      rect.setAttribute("y", String(((entry.sample.point[2] - minZ) / depth) * 100 - cell / 2));
      rect.setAttribute("width", String(cell));
      rect.setAttribute("height", String(cell));
      rect.setAttribute("fill", heatColor(best > 0 ? entry.hours / best : 0));
      const title = document.createElementNS(svgNs, "title");
      title.textContent = `${entry.hours.toFixed(2)} h`;
      rect.appendChild(title);
      svg.appendChild(rect);
    }
    map.replaceChildren(svg as unknown as Node, note("Plan view, north up. Darker is less sun. Hover a cell for its hours."));

    if (settings.mode === "selection") {
      // Colouring the model by hours is what makes the number arguable in a
      // meeting: the surface that loses the sun is the one that goes dark.
      const assignment = new Map<number, number>();
      const palette: Array<[number, number, number]> = [];
      for (let band = 0; band < 8; band++) {
        const t = band / 7;
        palette.push([Math.round(40 + t * 215), Math.round(40 + t * 175), Math.round(70 + t * 40)]);
      }
      for (const entry of exposure) {
        if (entry.id === undefined) continue;
        const band = best > 0 ? Math.min(7, Math.floor((entry.hours / best) * 8)) : 0;
        assignment.set(entry.id, band + 1);
      }
      ctx.view.colorBy(assignment, palette);
    }
  };

  const exportCsv = (): void => {
    if (exposure.length === 0) return void toast("Run the study first", "info");
    saveCsv(
      `sunlight-${settings.date}.csv`,
      ["X", "Y", "Z", "Sunlight hours", "Element"],
      exposure.map((entry) => [
        Number(entry.sample.point[0].toFixed(3)),
        Number(entry.sample.point[1].toFixed(3)),
        Number(entry.sample.point[2].toFixed(3)),
        Number(entry.hours.toFixed(3)),
        entry.id ?? "",
      ]),
    );
  };

  /** Read the site's own latitude and longitude, where the file carries them. */
  const readSite = async (): Promise<void> => {
    const tree = ctx.model.tree();
    if (!tree) return void toast("Open a model first", "info");
    const sites: number[] = [];
    const visit = (node: { expressID: number; type: string; children: Array<{ expressID: number; type: string; children: never[] }> }): void => {
      if (node.type === "IfcSite") sites.push(node.expressID);
      for (const child of node.children) visit(child as never);
    };
    visit(tree as never);
    for (const id of sites) {
      const properties = await ctx.model.properties(id);
      const latitude = compound(properties?.attributes.find((entry) => entry.name === "RefLatitude")?.value);
      const longitude = compound(properties?.attributes.find((entry) => entry.name === "RefLongitude")?.value);
      if (latitude === null || longitude === null) continue;
      settings.latitude = latitude;
      settings.longitude = longitude;
      store();
      paintControls();
      applyLight();
      ctx.feedback.log(`Read the site position from the model: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`, "success");
      return;
    }
    toast("This model does not carry a site latitude and longitude", "info");
  };

  // -- controls -------------------------------------------------------------

  const controls = h("div", { class: "sun-controls" });
  const runButton = button("Run day study", () => void run(), "accent");

  const paintControls = (): void => {
    const dateInput = h("input", { type: "date", value: settings.date });
    dateInput.addEventListener("change", () => {
      settings.date = dateInput.value || settings.date;
      store();
      applyLight();
    });
    const timeInput = h("input", {
      type: "range",
      min: "0",
      max: "1439",
      step: "5",
      value: String(settings.minutes),
      "aria-label": "Time of day",
    });
    timeInput.addEventListener("input", () => {
      settings.minutes = Number(timeInput.value);
      applyLight();
    });
    timeInput.addEventListener("change", () => store());

    const numberInput = (value: number, label: string, onChange: (next: number) => void, step = "0.01"): HTMLElement => {
      const input = h("input", { type: "number", class: "plug-num", value: String(value), step });
      input.addEventListener("change", () => {
        const next = Number(input.value);
        if (!Number.isFinite(next)) {
          input.value = String(value);
          return;
        }
        onChange(next);
        store();
        applyLight();
      });
      return h("label", { class: "plug-field" }, [h("span", { text: label }), input]);
    };

    controls.replaceChildren(
      h("label", { class: "plug-field" }, [h("span", { text: "Date" }), dateInput]),
      h("label", { class: "plug-field grow" }, [h("span", { text: "Time" }), timeInput]),
      numberInput(settings.latitude, "Latitude", (value) => (settings.latitude = Math.max(-90, Math.min(90, value)))),
      numberInput(settings.longitude, "Longitude", (value) => (settings.longitude = Math.max(-180, Math.min(180, value)))),
      numberInput(settings.utcOffsetMinutes / 60, "Site UTC offset h", (value) =>
        (settings.utcOffsetMinutes = Math.round(Math.max(-12, Math.min(14, value)) * 60)), "0.5"),
      numberInput(settings.northOffset, "North offset °", (value) => (settings.northOffset = value), "1"),
      h("label", { class: "plug-field" }, [
        h("span", { text: "Surface" }),
        select([["site", "Site grid"], ["selection", "Selected elements"]], settings.mode, (value) => {
          ctx.view.colorBy(new Map(), []);
          exposure = [];
          settings.mode = value as Mode;
          store();
          paintControls();
        }),
      ]),
      ...(settings.mode === "site"
        ? [
            numberInput(settings.gridMetres, "Grid m", (value) => (settings.gridMetres = Math.max(0.25, value)), "0.5"),
            numberInput(settings.height, "Height m", (value) => (settings.height = value), "0.5"),
          ]
        : []),
      numberInput(settings.stepMinutes, "Step min", (value) => (settings.stepMinutes = Math.round(Math.max(5, Math.min(120, value)))), "5"),
    );
  };

  const root = page(
    header("Sun and shadow", "The real sun for a date and a place, and the hours a surface sees it."),
    bar(
      runButton,
      button("Read site position", () => void readSite()),
      button("Neutral light", () => {
        ctx.view.setSun(null);
        readout.replaceChildren();
      }),
      button("Show all", () => ctx.view.showAll()),
      button("CSV", () => exportCsv()),
    ),
    hint("globe", "The light follows the NOAA solar position algorithm. The day study ray-casts each sample against the mesh; use its explicit site UTC offset and sampling grid when documenting results."),
    controls,
    readout,
    status.root,
    summary,
    map,
  );

  host.appendChild(root);
  paintControls();
  paintResult(0);
  if (ctx.session.model().loaded) applyLight();

  const off = ctx.events.on("model", () => {
    controller?.abort();
    ctx.view.colorBy(new Map(), []);
    exposure = [];
    paintResult(0);
  });

  return {
    dispose: () => {
      controller?.abort();
      off();
      ctx.view.colorBy(new Map(), []);
      ctx.view.setSun(null);
    },
  };
}

function sanitizeSettings(raw: Partial<Settings>): Settings {
  const number = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  return {
    latitude: number(raw.latitude, DEFAULTS.latitude, -90, 90),
    longitude: number(raw.longitude, DEFAULTS.longitude, -180, 180),
    date: typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : DEFAULTS.date,
    minutes: Math.round(number(raw.minutes, DEFAULTS.minutes, 0, 1439)),
    northOffset: number(raw.northOffset, DEFAULTS.northOffset, -360, 360),
    utcOffsetMinutes: Math.round(number(raw.utcOffsetMinutes, DEFAULTS.utcOffsetMinutes, -720, 840)),
    stepMinutes: Math.round(number(raw.stepMinutes, DEFAULTS.stepMinutes, 5, 120)),
    gridMetres: number(raw.gridMetres, DEFAULTS.gridMetres, 0.25, 1_000),
    height: number(raw.height, DEFAULTS.height, -10_000, 10_000),
    mode: raw.mode === "selection" ? "selection" : "site",
  };
}

/** Cold to warm, with enough contrast to read in both themes. */
function heatColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const r = Math.round(30 + clamped * 225);
  const g = Math.round(45 + clamped * 165);
  const b = Math.round(90 - clamped * 30);
  return `rgb(${r},${g},${b})`;
}

/**
 * IFC writes a latitude as (degrees, minutes, seconds, millionths). Different
 * exporters serialize that compound differently, so both a plain number and a
 * bracketed list have to read.
 */
function compound(value: string | number | boolean | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parts = value.match(/-?\d+(?:\.\d+)?/g);
  if (!parts || parts.length === 0) return null;
  const numbers = parts.map(Number);
  if (numbers.length === 1) return Number.isFinite(numbers[0]) ? numbers[0] : null;
  const sign = numbers[0] < 0 || value.trim().startsWith("-") ? -1 : 1;
  const degrees = Math.abs(numbers[0]);
  const minutes = Math.abs(numbers[1] ?? 0);
  const seconds = Math.abs(numbers[2] ?? 0);
  const millionths = Math.abs(numbers[3] ?? 0);
  return sign * (degrees + minutes / 60 + (seconds + millionths / 1e6) / 3600);
}
