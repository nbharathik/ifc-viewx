// Drive mode: the camera along an alignment, with the file's own chainage.
//
// A road is not looked at from outside; it is driven. The camera follows the
// sampled alignment, the readout says where it is in the station the drawing
// uses, and the eye height is a real one, so what the driver cannot see is
// what a driver cannot see.
import { h, icon, iconButton, toast } from "./kit.js";
import { chainage, positionAt, type SampledAlignment } from "../ifc/alignment.js";
import { schemaRow, SCHEMA_MATRIX, SUPPORT_LABEL } from "../ifc/schemas.js";
import type { CameraPose, Viewer } from "../viewer-core/viewer.js";

export interface DriveActions {
  log(message: string, kind?: "info" | "success" | "error"): void;
}

/** Metres per second at speed 1; a slow survey drive rather than a lap. */
const BASE_SPEED = 12;

export class DrivePanel {
  private readonly root: HTMLElement;
  private readonly picker = h("select", { class: "pop-select", "aria-label": "Alignment" });
  private readonly slider = h("input", {
    type: "range",
    min: "0",
    max: "1000",
    value: "0",
    step: "1",
    "aria-label": "Chainage",
  });
  private readonly readout = h("div", { class: "drive-readout" });
  private readonly playButton: HTMLButtonElement;
  private readonly eye = h("input", { type: "number", class: "plug-num", value: "1.5", step: "0.1", min: "0" });
  private readonly speed = h("input", { type: "number", class: "plug-num", value: "1", step: "0.5", min: "0.1" });
  private alignments: SampledAlignment[] = [];
  private station = 0;
  private playing = false;
  private frame = 0;
  private last = 0;
  private restore: CameraPose | null = null;

  constructor(host: HTMLElement, private readonly viewer: Viewer, private readonly actions: DriveActions) {
    this.playButton = h("button", { class: "btn sm accent", type: "button", text: "Drive" });
    this.playButton.addEventListener("click", () => this.setPlaying(!this.playing));

    this.picker.addEventListener("change", () => {
      this.station = 0;
      this.sync();
    });
    this.slider.addEventListener("input", () => {
      const active = this.active();
      if (!active) return;
      this.station = (Number(this.slider.value) / 1000) * active.length;
      this.apply();
    });

    const close = iconButton("x", "Close drive mode", () => this.hide(), "icon-btn sm");
    this.root = h("div", { class: "drive-card hidden" }, [
      h("div", { class: "drive-head" }, [
        icon("walk", 13),
        h("span", { class: "grow", text: "Drive alignment" }),
        close,
      ]),
      this.picker,
      this.slider,
      this.readout,
      h("div", { class: "drive-row" }, [
        this.playButton,
        h("label", { class: "plug-field", title: "Eye height above the alignment" }, [
          h("span", { text: "eye m" }),
          this.eye,
        ]),
        h("label", { class: "plug-field", title: "Speed multiplier" }, [h("span", { text: "speed" }), this.speed]),
      ]),
    ]);
    host.appendChild(this.root);
  }

  /** Show the panel for a set of alignments, or explain that there are none. */
  present(alignments: SampledAlignment[], schema: string): void {
    this.alignments = alignments.filter((alignment) => alignment.points.length > 1);
    if (this.alignments.length === 0) {
      this.hide();
      const row = schemaRow(schema);
      toast(
        row && row.linear === "none"
          ? `${row.label} has no alignment entities: this is a building schema.`
          : "No IFC alignment in this model.",
        "info",
      );
      this.actions.log(
        `No alignments found. ${SCHEMA_MATRIX.map((entry) => `${entry.label}: alignments ${SUPPORT_LABEL[entry.linear].toLowerCase()}`).join("; ")}`,
      );
      return;
    }
    this.picker.replaceChildren(
      ...this.alignments.map((alignment, index) =>
        h("option", {
          value: String(index),
          text: `${alignment.name} · ${alignment.length.toFixed(0)} m${alignment.hasVertical ? "" : " (flat)"}`,
        })),
    );
    this.picker.value = "0";
    this.station = 0;
    this.restore = this.viewer.getCamera();
    this.root.classList.remove("hidden");
    this.sync();
    const approximated = this.alignments.flatMap((alignment) => alignment.approximated);
    if (approximated.length) {
      this.actions.log(
        `Alignment transition curves of type ${[...new Set(approximated)].join(", ")} are integrated as clothoids.`,
      );
    }
  }

  hide(): void {
    this.setPlaying(false);
    this.root.classList.add("hidden");
    if (this.restore) {
      this.viewer.setCamera(this.restore);
      this.restore = null;
    }
  }

  isOpen(): boolean {
    return !this.root.classList.contains("hidden");
  }

  private active(): SampledAlignment | null {
    return this.alignments[Number(this.picker.value) || 0] ?? null;
  }

  private sync(): void {
    const active = this.active();
    if (!active) return;
    this.slider.value = String(active.length > 0 ? Math.round((this.station / active.length) * 1000) : 0);
    this.apply();
  }

  /**
   * Put the camera on the alignment. Samples already share the rendered
   * model's metre/Y-up frame; only federation placement and the shared scene
   * origin remain to be applied here.
   */
  private apply(): void {
    const active = this.active();
    if (!active) return;
    const at = positionAt(active, this.station);
    if (!at) return;
    const ahead = positionAt(active, Math.min(active.length, this.station + 12)) ?? at;
    const origin = this.viewer.getModelOrigin();
    // The semantic worker tracks the primary (slot 0) IFC model. Match the
    // same uniform plan transform the mesh batcher applies to that model.
    const placement = this.viewer.getModels().find((model) => model.index === 0)?.transform;
    const rotation = placement?.rotationZ ?? 0;
    const scale = placement?.scale ?? 1;
    const translation = placement?.translation ?? [0, 0, 0];
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    const scene = (point: [number, number, number]): [number, number, number] => [
      scale * (cosine * point[0] + sine * point[2]) + translation[0] - origin[0],
      scale * point[1] + translation[1] - origin[1],
      scale * (-sine * point[0] + cosine * point[2]) + translation[2] - origin[2],
    ];
    const atScene = scene(at.point);
    const aheadScene = scene(ahead.point);
    const parsedEye = Number(this.eye.value);
    const eye = Number.isFinite(parsedEye) && parsedEye >= 0 ? parsedEye : 1.5;
    this.viewer.setCamera({
      position: [atScene[0], atScene[1] + eye, atScene[2]],
      target: [aheadScene[0], aheadScene[1] + eye, aheadScene[2]],
    });
    const grade = gradeBetween(at.point, ahead.point);
    this.readout.replaceChildren(
      h("b", { text: chainage(at.station) }),
      h("span", { text: `${at.point[1].toFixed(2)} m` }),
      h("span", { text: `${((at.direction + rotation) * 180 / Math.PI).toFixed(1)}°` }),
      h("span", { text: `${(grade * 100).toFixed(2)}%` }),
    );
  }

  private setPlaying(on: boolean): void {
    if (on === this.playing) return;
    this.playing = on;
    this.playButton.textContent = on ? "Stop" : "Drive";
    this.playButton.classList.toggle("accent", !on);
    if (!on) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      return;
    }
    this.last = performance.now();
    const step = (): void => {
      if (!this.playing) return;
      const active = this.active();
      if (!active) return;
      const now = performance.now();
      const seconds = Math.min(0.2, (now - this.last) / 1000);
      this.last = now;
      this.station += seconds * BASE_SPEED * (Number(this.speed.value) || 1);
      if (this.station >= active.length) {
        this.station = active.length;
        this.setPlaying(false);
      }
      this.slider.value = String(active.length > 0 ? Math.round((this.station / active.length) * 1000) : 0);
      this.apply();
      if (this.playing) this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }
}

function gradeBetween(a: [number, number, number], b: [number, number, number]): number {
  const run = Math.hypot(b[0] - a[0], b[2] - a[2]);
  return run > 1e-6 ? (b[1] - a[1]) / run : 0;
}
