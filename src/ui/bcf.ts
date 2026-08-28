// BCF: issues pinned to a viewpoint. Topics can stay beside the model in this
// browser, travel as a .bcfzip (BCF 2.1), or sync with an OpenCDE BCF 3 project.
// Cameras use viewer world coordinates so they round trip exactly here.
import { busyRow, confirmAction, h, icon, iconButton, lightDismiss, promptForm, toast } from "./kit.js";
import { emptyState } from "./shell.js";
import type { ReportIssue } from "./report.js";
import type { CameraPose, Viewer } from "../viewer-core/viewer.js";
import {
  OpenCdeClient,
  OpenCdeEndpointTrustError,
  type BcfProject,
  type BcfProjectExtensions,
  type OpenCdeAuth,
  type OpenCdeFetch,
} from "../opencde/client.js";
import {
  fromBcfViewpoint,
  fromBcfTopic,
  pendingCount,
  toBcfTopic,
  toBcfViewpoint,
  type ReviewComment,
  type ReviewTopic,
} from "../opencde/bridge.js";

export interface BcfCaptureOptions {
  elementIds?: number[];
  priority?: string;
  point?: [number, number, number];
}

type Topic = ReviewTopic;

const STATUS = ["Open", "In Progress", "Resolved", "Closed"];
const PRIORITY = ["Low", "Normal", "High", "Critical"];
/** Snapshot width kept small: topics share one localStorage budget. */
const SNAP_WIDTH = 560;
/** Above this the hidden set is not stored; restoring then shows everything. */
const HIDDEN_LIMIT = 2000;
const LAST_SERVER_KEY = "ifcviewx.opencde.server";
const LAST_PROJECT_KEY = "ifcviewx.opencde.project";

const uuid = (): string =>
  crypto.randomUUID?.() ??
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });

// -- zip --------------------------------------------------------------------
const CRC = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Stored entries only: snapshots are already compressed and markup is tiny. */
function zip(files: Array<{ name: string; data: Uint8Array }>): Blob {
  const encoder = new TextEncoder();
  const body: BlobPart[] = [];
  const directory: BlobPart[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const sum = crc32(file.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(12, 0x21, true);
    local.setUint32(14, sum, true);
    local.setUint32(18, file.data.length, true);
    local.setUint32(22, file.data.length, true);
    local.setUint16(26, name.length, true);
    body.push(local.buffer, name, file.data as BlobPart);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(14, 0x21, true);
    entry.setUint32(16, sum, true);
    entry.setUint32(20, file.data.length, true);
    entry.setUint32(24, file.data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    directory.push(entry.buffer, name);
    offset += 30 + name.length + file.data.length;
  }
  const size = directory.reduce((sum, part) => sum + (part as ArrayBuffer | Uint8Array).byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...body, ...directory, end.buffer], { type: "application/zip" });
}

const BCF_MAX_ENTRIES = 4096;
const BCF_MAX_TOTAL = 256 * 1024 * 1024;

async function unzip(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // A hostile or truncated archive must fail with a sentence, not a raw
  // out-of-range DataView throw, and must never inflate without a ceiling.
  const u16 = (at: number): number => {
    if (at < 0 || at + 2 > buffer.byteLength) throw new Error("That BCF file is damaged.");
    return view.getUint16(at, true);
  };
  const u32 = (at: number): number => {
    if (at < 0 || at + 4 > buffer.byteLength) throw new Error("That BCF file is damaged.");
    return view.getUint32(at, true);
  };
  let end = -1;
  for (let i = buffer.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("That file is not a zip archive.");
  const count = u16(end + 10);
  if (count > BCF_MAX_ENTRIES) throw new Error("That BCF file has too many entries.");
  const decoder = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  let at = u32(end + 16);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const nameLength = u16(at + 28);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const method = u16(at + 10);
    const size = u32(at + 20);
    const local = u32(at + 42);
    const start = local + 30 + u16(local + 26) + u16(local + 28);
    total += size;
    if (total > BCF_MAX_TOTAL) throw new Error("That BCF file is too large to open.");
    if (method === 0) {
      if (start + size > buffer.byteLength) throw new Error("That BCF file is damaged.");
      out.set(name, bytes.subarray(start, start + size));
    } else if (method === 8) {
      const raw = bytes.subarray(start, start + size);
      const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
      total += inflated.byteLength - size;
      if (total > BCF_MAX_TOTAL) throw new Error("That BCF file is too large to open.");
      out.set(name, inflated);
    }
    at += 46 + nameLength + u16(at + 30) + u16(at + 32);
  }
  return out;
}

// -- BCF xml ----------------------------------------------------------------
const escape = (text: string): string =>
  text.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
// Stored dates stay ISO/UTC because BCF requires it, but a reviewer reads the
// clock on their own wall.
const localDate = (iso: string, withTime: boolean): string => {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso.slice(0, withTime ? 16 : 10).replace("T", " ");
  const date = new Date(time);
  return withTime
    ? `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : date.toLocaleDateString();
};
const point = (tag: string, v: [number, number, number]): string =>
  `<${tag}><X>${v[0]}</X><Y>${v[1]}</Y><Z>${v[2]}</Z></${tag}>`;

function direction(pose: CameraPose): [number, number, number] {
  const d: [number, number, number] = [
    pose.target[0] - pose.position[0],
    pose.target[1] - pose.position[1],
    pose.target[2] - pose.position[2],
  ];
  const length = Math.hypot(...d) || 1;
  return [d[0] / length, d[1] / length, d[2] / length];
}

/** World up projected off the view direction, so the camera has no roll. */
function upVector(d: [number, number, number]): [number, number, number] {
  const dot = d[1];
  const up: [number, number, number] = [-d[0] * dot, 1 - d[1] * dot, -d[2] * dot];
  const length = Math.hypot(...up);
  return length < 1e-6 ? [0, 0, 1] : [up[0] / length, up[1] / length, up[2] / length];
}

function markupXml(topic: Topic): string {
  const comments = topic.comments
    .map(
      (comment) =>
        `<Comment Guid="${escape(comment.guid)}"><Date>${escape(comment.date)}</Date><Author>${escape(comment.author)}</Author>` +
        `<Comment>${escape(comment.text)}</Comment></Comment>`,
    )
    .join("");
  const viewpoint = topic.viewpoint
    ? `<Viewpoints Guid="${topic.guid}"><Viewpoint>viewpoint.bcfv</Viewpoint>${
        topic.snapshot ? "<Snapshot>snapshot.png</Snapshot>" : ""
      }</Viewpoints>`
    : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<Markup>` +
    `<Topic Guid="${escape(topic.guid)}" TopicType="${escape(topic.topicType || "Issue")}" TopicStatus="${escape(topic.status)}">` +
    `<Title>${escape(topic.title)}</Title><Priority>${escape(topic.priority)}</Priority>` +
    `<CreationDate>${escape(topic.date)}</CreationDate><CreationAuthor>${escape(topic.author)}</CreationAuthor>` +
    `<Description>${escape(topic.description)}</Description>` +
    (topic.assignedTo ? `<AssignedTo>${escape(topic.assignedTo)}</AssignedTo>` : "") +
    `</Topic>` +
    comments +
    viewpoint +
    `</Markup>`
  );
}

function viewpointXml(topic: Topic): string {
  const view = topic.viewpoint;
  if (!view) return "";
  const d = direction(view.camera);
  const up = upVector(d);
  const component = (id: number, guid: string | null): string =>
    `<Component${guid ? ` IfcGuid="${escape(guid)}"` : ""} OriginatingSystem="IFCViewX" AuthoringToolId="${id}"/>`;
  const selections = view.selections ?? (
    view.selection === null || view.selection === undefined
      ? []
      : [{ id: view.selection, guid: view.selectionGuid ?? null }]
  );
  const selection = selections.length
    ? `<Selection>${selections.map((item) => component(item.id, item.guid)).join("")}</Selection>`
    : "";
  const exceptions =
    view.hidden.length && view.hidden.length <= 500
      ? `<Exceptions>${view.hidden.map((id) => component(id, null)).join("")}</Exceptions>`
      : "";
  const sections = view.sections
    .map((section) => {
      // Direction points into the kept half-space, matching the axis export
      // convention that predates arbitrary planes.
      const n: [number, number, number] = section.axis
        ? [section.axis === "x" ? 1 : 0, section.axis === "y" ? 1 : 0, section.axis === "z" ? 1 : 0]
        : section.normal;
      const location: [number, number, number] = [n[0] * section.offset, n[1] * section.offset, n[2] * section.offset];
      const normal: [number, number, number] = section.flip ? [n[0], n[1], n[2]] : [-n[0], -n[1], -n[2]];
      return `<ClippingPlane>${point("Location", location)}${point("Direction", normal)}</ClippingPlane>`;
    })
    .join("");
  const box = view.sectionBox;
  const boxPlanes = box
    ? ([
        [0, box.min[0], 1], [0, box.max[0], -1],
        [1, box.min[1], 1], [1, box.max[1], -1],
        [2, box.min[2], 1], [2, box.max[2], -1],
      ] as Array<[number, number, number]>).map(([axis, offset, direction]) => {
        const location: [number, number, number] = [0, 0, 0];
        const normal: [number, number, number] = [0, 0, 0];
        location[axis] = offset;
        normal[axis] = direction;
        return `<ClippingPlane>${point("Location", location)}${point("Direction", normal)}</ClippingPlane>`;
      }).join("")
    : "";
  const planes = boxPlanes || sections;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<VisualizationInfo Guid="${escape(topic.guid)}">` +
    `<Components><Visibility DefaultVisibility="true">${exceptions}</Visibility>${selection}</Components>` +
    `<PerspectiveCamera>${point("CameraViewPoint", view.camera.position)}${point("CameraDirection", d)}` +
    `${point("CameraUpVector", up)}<FieldOfView>60</FieldOfView></PerspectiveCamera>` +
    (planes ? `<ClippingPlanes>${planes}</ClippingPlanes>` : "") +
    `</VisualizationInfo>`
  );
}

const text = (node: Element | Document, tag: string): string =>
  node.getElementsByTagName(tag)[0]?.textContent?.trim() ?? "";

function readVector(node: Element | null): [number, number, number] | null {
  if (!node) return null;
  const read = (tag: string): number => Number(node.getElementsByTagName(tag)[0]?.textContent ?? NaN);
  const v: [number, number, number] = [read("X"), read("Y"), read("Z")];
  return v.every(Number.isFinite) ? v : null;
}

function parseTopic(markup: string, viewpoint: string | null, snapshot: string | null): Topic | null {
  const doc = new DOMParser().parseFromString(markup, "application/xml");
  const node = doc.getElementsByTagName("Topic")[0];
  if (!node) return null;
  const topic: Topic = {
    guid: node.getAttribute("Guid") ?? uuid(),
    title: text(node, "Title") || "Untitled",
    description: text(node, "Description"),
    status: node.getAttribute("TopicStatus") || "Open",
    priority: text(node, "Priority") || "Normal",
    author: text(node, "CreationAuthor") || "unknown",
    date: text(node, "CreationDate") || new Date().toISOString(),
    modifiedAt: text(node, "ModifiedDate") || undefined,
    topicType: node.getAttribute("TopicType") || "Issue",
    assignedTo: text(node, "AssignedTo") || undefined,
    comments: [...doc.getElementsByTagName("Comment")]
      .filter((item) => item.parentElement?.tagName === "Markup")
      .map((item) => ({
        guid: item.getAttribute("Guid") ?? uuid(),
        date: text(item, "Date"),
        author: text(item, "Author"),
        text: item.getElementsByTagName("Comment")[0]?.textContent?.trim() ?? "",
      })),
    viewpoint: null,
    snapshot,
  };
  if (!viewpoint) return topic;
  const view = new DOMParser().parseFromString(viewpoint, "application/xml");
  const camera = view.getElementsByTagName("PerspectiveCamera")[0] ?? view.getElementsByTagName("OrthogonalCamera")[0];
  const position = readVector(camera?.getElementsByTagName("CameraViewPoint")[0] ?? null);
  const heading = readVector(camera?.getElementsByTagName("CameraDirection")[0] ?? null);
  if (position && heading) {
    const span = 10;
    const clipping = [...view.getElementsByTagName("ClippingPlane")].flatMap((plane) => {
      const location = readVector(plane.getElementsByTagName("Location")[0] ?? null);
      const normal = readVector(plane.getElementsByTagName("Direction")[0] ?? null);
      if (!location || !normal) return [];
      const axis = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
      return [{ axis, location, normal }];
    });
    // The six-plane box heuristic only counts axis-dominant planes; a tilted
    // plane in the set must never masquerade as a box face.
    const axisDominant = clipping.filter((plane) => {
      const len = Math.hypot(...plane.normal) || 1;
      return Math.abs(plane.normal[plane.axis]) > 0.999 * len;
    });
    const byAxis = [0, 1, 2].map((axis) => axisDominant.filter((plane) => plane.axis === axis));
    // A box keeps its interior: per axis the lower plane's Direction must
    // point up the axis and the upper one down it, or two same-side planes
    // would masquerade as a box and invert the cut on import.
    const boxLike = byAxis.every((planes) => {
      if (planes.length !== 2) return false;
      const [a, b] = [...planes].sort((p, q) => p.location[p.axis] - q.location[q.axis]);
      return a.normal[a.axis] > 0 && b.normal[b.axis] < 0;
    });
    const sectionBox = axisDominant.length === clipping.length && boxLike
      ? {
          min: byAxis.map((planes, axis) => Math.min(...planes.map((plane) => plane.location[axis]))) as [number, number, number],
          max: byAxis.map((planes, axis) => Math.max(...planes.map((plane) => plane.location[axis]))) as [number, number, number],
        }
      : null;
    const selections = [...view.getElementsByTagName("Selection")[0]?.getElementsByTagName("Component") ?? []]
      .flatMap((component) => {
        const id = Number(component.getAttribute("AuthoringToolId") ?? NaN);
        return Number.isFinite(id) && id > 0 ? [{ id, guid: component.getAttribute("IfcGuid") }] : [];
      });
    topic.viewpoint = {
      camera: {
        position,
        target: [position[0] + heading[0] * span, position[1] + heading[1] * span, position[2] + heading[2] * span],
      },
      sections: sectionBox ? [] : clipping.map((plane) => {
        const len = Math.hypot(...plane.normal) || 1;
        if (Math.abs(plane.normal[plane.axis]) > 0.999 * len) {
          return {
            axis: (["x", "y", "z"] as const)[plane.axis],
            offset: plane.location[plane.axis],
            flip: plane.normal[plane.axis] > 0,
          };
        }
        // BCF Direction points at the kept side; our normal points at the
        // discarded one when flip is false.
        const n = plane.normal.map((v) => -v / len) as [number, number, number];
        return {
          id: "",
          name: "Imported plane",
          normal: n,
          offset: n[0] * plane.location[0] + n[1] * plane.location[1] + n[2] * plane.location[2],
          flip: false,
        };
      }),
      sectionBox,
      selections,
      hidden: [],
    };
  }
  return topic;
}

// -- panel ------------------------------------------------------------------
export interface BcfActions {
  viewer: Viewer;
  modelName(): string;
  log(message: string, kind?: "info" | "success" | "error"): void;
  /** Load a file the CDE handed over: as the model, or beside it to compare. */
  openDocument?(name: string, bytes: Uint8Array, intent: "open" | "compare"): Promise<void>;
  compareDocuments?: boolean;
  openCdeFetch?: OpenCdeFetch;
}

async function snapshot(viewer: Viewer): Promise<string | null> {
  const blob = await viewer.captureImage(SNAP_WIDTH, "image/jpeg", 0.7);
  return blob ? dataUrl(new Uint8Array(await blob.arrayBuffer()), "image/jpeg") : null;
}

/**
 * BCF wants a png, storage wants small, so the export re-encodes. Decoding
 * goes through createImageBitmap: HTMLImageElement.decode() stalls while the
 * document is not visible, which is exactly when a long export runs.
 */
async function toPng(dataUrl: string): Promise<Uint8Array> {
  const source = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext("2d")?.drawImage(source, 0, 0);
  source.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array();
}

export class BcfPanel {
  private readonly workspace = h("section", { class: "cde-workspace", "aria-label": "Connected project" });
  private readonly list = h("div", { class: "scroll" });
  private readonly empty = emptyState("flag", "No issues yet", "Raise one from the current view; it keeps the camera, the section and the snapshot.");
  private readonly status = h("div", { class: "status-line" });
  private readonly file = h("input", { type: "file", accept: ".bcfzip,.zip", hidden: true });
  private readonly client: OpenCdeClient;
  private author = localStorage.getItem("ifcviewx.bcf.author") ?? "me";
  private topics: Topic[] = [];
  private expanded: string | null = null;
  private project: BcfProject | null = null;
  private extensions: BcfProjectExtensions | null = null;
  private syncing = false;
  private lastSync: Date | null = null;

  constructor(host: HTMLElement, private readonly actions: BcfActions) {
    this.client = new OpenCdeClient(actions.openCdeFetch);
    const create = h("button", { class: "btn accent", type: "button" }, [icon("plus", 14), h("span", { text: "New issue" })]);
    create.addEventListener("click", () => this.capture("", ""));
    const exportBtn = h("button", { class: "btn", type: "button", title: "Download a .bcfzip" }, [icon("download", 14)]);
    exportBtn.addEventListener("click", () => void this.export().catch((err: Error) => toast(err.message, "error")));
    const importBtn = h("button", { class: "btn", type: "button", title: "Load a .bcfzip" }, [icon("upload", 14)]);
    importBtn.addEventListener("click", () => this.file.click());
    this.file.addEventListener("change", () => {
      const picked = this.file.files?.[0];
      if (picked) void this.import(picked).catch((err: Error) => toast(err.message, "error"));
      this.file.value = "";
    });

    host.appendChild(
      h("div", { class: "page" }, [
        this.workspace,
        h("div", { class: "row" }, [create, h("span", { class: "grow" }), importBtn, exportBtn, this.file]),
        this.status,
        this.empty,
        this.list,
      ]),
    );

    actions.viewer.onModelLoaded(() => {
      this.refresh();
      if (this.project) void this.pullRemote();
    });
    this.refresh();
  }

  refresh(): void {
    this.topics = this.read();
    this.render();
  }

  /** Flattened for the offline report; the snapshot travels as it is stored. */
  reportIssues(): ReportIssue[] {
    return this.topics.map((topic) => ({
      title: topic.title,
      status: topic.status,
      priority: topic.priority,
      author: topic.author,
      date: topic.date,
      description: topic.description,
      snapshot: topic.snapshot,
    }));
  }

  /** The current viewer state as a viewpoint, so capture and recapture agree. */
  private viewpointNow(selectedIds: number[]): ReviewTopic["viewpoint"] {
    const viewer = this.actions.viewer;
    const counts = viewer.getVisibilityCounts();
    const hidden =
      counts.hidden > 0 && counts.hidden <= HIDDEN_LIMIT
        ? [...viewer.getElementTypes().keys()].filter((id) => !viewer.isElementVisible(id))
        : [];
    return {
      camera: viewer.getCamera(),
      sections: viewer.getSections(),
      sectionBox: viewer.getSectionBox(),
      selections: selectedIds.map((id) => ({ id, guid: null })),
      hidden,
      annotations: viewer.getAnnotationStates(),
    };
  }

  /** Raise an issue on what is on screen now. Empty title opens the editor. */
  capture(title: string, description: string, options: BcfCaptureOptions = {}): string | null {
    if (!this.key()) {
      toast("Open a model first", "info");
      return null;
    }
    const viewer = this.actions.viewer;
    const selectedIds = [...new Set(options.elementIds ?? viewer.getSelectedIds())]
      .filter((id) => Number.isFinite(id) && id > 0);
    const active = this.activeProject();
    const focusPoint = options.point ?? viewer.getCamera().target;
    const projected = typeof viewer.sceneToGeoreferenced === "function"
      ? viewer.sceneToGeoreferenced(focusPoint)
      : null;
    const georeference = projected
      ? `Georeferenced coordinate (${projected.crs}): ${projected.coordinates.map((value) => value.toFixed(3)).join(", ")}`
      : "";
    const topic: Topic = {
      guid: uuid(),
      title: title || "New issue",
      description: [description, georeference].filter(Boolean).join("\n\n"),
      status: "Open",
      priority: PRIORITY.includes(options.priority ?? "") ? options.priority! : "Normal",
      author: this.author,
      date: new Date().toISOString(),
      comments: [],
      modifiedAt: new Date().toISOString(),
      topicType: "Issue",
      viewpoint: this.viewpointNow(selectedIds),
      snapshot: null,
      ...(active ? {
        remote: {
          serverUrl: active.serverUrl,
          projectId: active.projectId,
          state: "pending-create" as const,
          viewDirty: true,
          pendingComments: [],
        },
      } : {}),
    };
    void snapshot(viewer).then((shot) => {
      topic.snapshot = shot;
      if (shot && topic.remote?.state === "synced" && !topic.remote.viewDirty) this.stageEdit(topic, true);
      this.save();
      this.render();
    });
    if (selectedIds.length) {
      void Promise.all(selectedIds.map(async (id) => {
        const props = await viewer.getProperties(id).catch(() => null);
        const guid = props?.attributes.find((item) => item.name === "GlobalId")?.value;
        const selection = topic.viewpoint?.selections?.find((item) => item.id === id);
        if (guid && selection) selection.guid = String(guid);
      })).then(() => {
        if (topic.remote?.state === "synced" && !topic.remote.viewDirty) this.stageEdit(topic, true);
        this.save();
        this.renderWorkspace();
      });
    }
    this.topics.unshift(topic);
    this.expanded = topic.guid;
    this.save();
    this.render();
    this.actions.log(`Issue raised: ${topic.title}`, "success");
    return topic.guid;
  }

  // -- storage --------------------------------------------------------------
  private key(): string | null {
    const stats = this.actions.viewer.getStats();
    return stats ? `ifcviewx.bcf.${stats.totalEntities}-${stats.triangleCount}` : null;
  }

  private read(): Topic[] {
    const key = this.key();
    if (!key) return [];
    try {
      return JSON.parse(localStorage.getItem(key) ?? "[]") as Topic[];
    } catch {
      return [];
    }
  }

  private save(): void {
    const key = this.key();
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(this.topics));
    } catch {
      // Snapshots are the bulk; drop the oldest ones rather than lose topics.
      for (const topic of [...this.topics].reverse()) {
        if (!topic.snapshot) continue;
        topic.snapshot = null;
        try {
          localStorage.setItem(key, JSON.stringify(this.topics));
          toast("Storage is full: older snapshots were dropped", "info");
          return;
        } catch {
          continue;
        }
      }
      toast("Could not store the issue: browser storage is full", "error");
    }
  }

  // -- transfer -------------------------------------------------------------
  private async export(): Promise<void> {
    if (this.topics.length === 0) return void toast("No issues to export", "info");
    const files: Array<{ name: string; data: Uint8Array }> = [
      {
        name: "bcf.version",
        data: utf8('<?xml version="1.0" encoding="UTF-8"?>\n<Version VersionId="2.1"><DetailedVersion>2.1</DetailedVersion></Version>'),
      },
    ];
    for (const topic of this.topics) {
      files.push({ name: `${topic.guid}/markup.bcf`, data: utf8(markupXml(topic)) });
      if (topic.viewpoint) files.push({ name: `${topic.guid}/viewpoint.bcfv`, data: utf8(viewpointXml(topic)) });
      if (topic.snapshot) files.push({ name: `${topic.guid}/snapshot.png`, data: await toPng(topic.snapshot) });
    }
    const url = URL.createObjectURL(zip(files));
    const link = h("a", { href: url, download: `${this.actions.modelName().replace(/\.[^.]+$/, "") || "issues"}.bcfzip` });
    link.click();
    // Revoking in the same task cancels the download on some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.actions.log(`Exported ${this.topics.length} issues as BCF`, "success");
  }

  private async import(file: File): Promise<void> {
    // Topics are stored per model, so with nothing open save() is a no-op and
    // the import would vanish at the next load without ever saying so.
    if (!this.key()) throw new Error("Open a model first: issues are stored against the model they belong to.");
    const entries = await unzip(await file.arrayBuffer());
    const decoder = new TextDecoder();
    const folders = new Set([...entries.keys()].filter((name) => name.endsWith("markup.bcf")).map((name) => name.replace(/markup\.bcf$/, "")));
    let added = 0;
    for (const folder of folders) {
      const markup = entries.get(`${folder}markup.bcf`);
      if (!markup) continue;
      const view = entries.get(`${folder}viewpoint.bcfv`);
      const png = entries.get(`${folder}snapshot.png`);
      const image = png ?? entries.get(`${folder}snapshot.jpg`);
      const topic = parseTopic(
        decoder.decode(markup),
        view ? decoder.decode(view) : null,
        image ? await dataUrl(image, png ? "image/png" : "image/jpeg") : null,
      );
      if (!topic || this.topics.some((item) => item.guid === topic.guid)) continue;
      this.topics.push(topic);
      added++;
    }
    this.save();
    this.render();
    this.status.textContent = `Imported ${added} issue${added === 1 ? "" : "s"} from ${file.name}`;
    this.actions.log(this.status.textContent, added ? "success" : "info");
  }

  // -- view -----------------------------------------------------------------
  private restore(topic: Topic): void {
    const view = topic.viewpoint;
    if (!view) return;
    const viewer = this.actions.viewer;
    if (view.hidden.length) {
      const off = new Set(view.hidden);
      viewer.isolate([...viewer.getElementTypes().keys()].filter((id) => !off.has(id)));
    } else {
      viewer.showAll();
    }
    if (view.sectionBox) viewer.setSectionBox(view.sectionBox);
    else if (view.sections.length) viewer.setSections(view.sections);
    else viewer.clearSection();
    viewer.setCamera(view.camera);
    if (view.annotations?.length) viewer.setAnnotationStates(view.annotations);
    const selected = view.selections?.map((item) => item.id) ?? (
      view.selection === null || view.selection === undefined ? [] : [view.selection]
    );
    if (selected.length) viewer.selectMany(selected, "replace");
  }

  // -- connected workspace -------------------------------------------------
  private activeProject(): { serverUrl: string; projectId: string } | null {
    const session = this.client.getSession();
    return session && this.project ? { serverUrl: session.serverUrl, projectId: this.project.project_id } : null;
  }

  private isActiveRemote(topic: Topic): boolean {
    const active = this.activeProject();
    return Boolean(active && topic.remote?.serverUrl === active.serverUrl && topic.remote.projectId === active.projectId);
  }

  private setStatus(message: string, error = false): void {
    this.status.textContent = message;
    this.status.classList.toggle("error", error);
  }

  private renderWorkspace(): void {
    const active = this.activeProject();
    if (!active || !this.project) {
      const connect = h("button", {
        class: "btn sm",
        type: "button",
        text: "Connect project",
        "data-action": "open-cde-connect",
      });
      connect.addEventListener("click", () => this.openConnectionDialog());
      this.workspace.dataset.state = "local";
      this.workspace.replaceChildren(
        h("span", { class: "cde-signal", "aria-hidden": "true" }),
        h("div", { class: "cde-identity grow" }, [
          h("strong", { text: "Local review" }),
          h("span", { text: "BCF issues stay in this browser" }),
        ]),
        connect,
      );
      return;
    }

    const count = pendingCount(this.topics, active.serverUrl, active.projectId);
    const sync = h("button", {
      class: "btn sm cde-sync",
      type: "button",
      disabled: this.syncing,
      "data-action": "open-cde-sync",
      title: count ? `Send ${count} queued change${count === 1 ? "" : "s"} and pull the project` : "Pull the latest project issues",
    }, [icon("refresh", 13), h("span", { text: this.syncing ? "Syncing" : "Sync" })]);
    sync.addEventListener("click", () => void this.sync());
    const disconnect = iconButton("x", "Disconnect project", () => this.disconnect(), "icon-btn sm");
    // Revisions arriving through the connection they were issued on, rather
    // than through the downloads folder, is the other half of a CDE link.
    const documents = iconButton(
      "folder",
      this.client.hasDocuments() ? "Documents on this CDE" : "This server does not advertise the Documents API",
      () => void this.openDocuments(),
      "icon-btn sm",
    );
    documents.disabled = !this.client.hasDocuments();
    const host = new URL(active.serverUrl).host;
    const detail = count
      ? `${count} queued · ${host}`
      : this.lastSync
        ? `Up to date · ${this.lastSync.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : host;
    this.workspace.dataset.state = count ? "pending" : "connected";
    this.workspace.replaceChildren(
      h("span", { class: "cde-signal", "aria-hidden": "true" }),
      h("div", { class: "cde-identity grow" }, [
        h("strong", { text: this.project.name }),
        h("span", { text: detail, title: active.serverUrl }),
      ]),
      count ? h("span", { class: "cde-queue", text: String(count), title: "Queued changes" }) : h("span"),
      documents,
      sync,
      disconnect,
    );
  }

  /**
   * The Documents half of the CDE link. A document listed here is pulled
   * straight into the viewer: opened, added to the federation, or sent into
   * Model Compare against what is already open, which is the whole reason a
   * revision matters.
   */
  async openDocuments(): Promise<void> {
    if (!this.client.hasDocuments()) {
      return void toast("This server does not advertise the OpenCDE Documents API", "info");
    }
    const list = h("div", { class: "reg-list" });
    const body = h("div", { class: "dlg-body" }, [busyRow("Reading the document register")]);
    const close = h("button", { class: "btn primary", type: "button", text: "Close" });
    const reference = h("button", { class: "btn", type: "button", text: "Open a reference" });
    const dialog = h("dialog", { class: "form-dialog wide", "aria-label": "CDE documents" }, [
      h("div", { class: "dlg-head" }, [h("span", { text: "Documents" })]),
      body,
      h("div", { class: "dlg-foot" }, [reference, close]),
    ]) as HTMLDialogElement;
    close.addEventListener("click", () => dialog.close());
    reference.addEventListener("click", () => {
      promptForm(
        "Open a document reference",
        [{ key: "url", label: "Reference URL", hint: "The URL a BCF topic or the server's picker handed over." }],
        "Open",
        (values) => {
          const url = values.url.trim();
          if (!url) return;
          void this.client
            .documentReference(url)
            .then((document_) => this.pullDocument(document_))
            .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), "error"));
        },
      );
    });
    dialog.addEventListener("close", () => dialog.remove());
    document.body.appendChild(dialog);
    dialog.showModal();

    try {
      const documents = await this.client.documents();
      if (documents.length === 0) {
        body.replaceChildren(h("div", {
          class: "note",
          text: "This server lists no documents through the API. Use Open a reference with the URL its own picker or a BCF topic gives you.",
        }));
        return;
      }
      for (const document_ of documents) list.appendChild(this.documentRow(document_));
      body.replaceChildren(list);
    } catch (error) {
      body.replaceChildren(h("div", { class: "note error", text: error instanceof Error ? error.message : String(error) }));
    }
  }

  private documentRow(document_: { guid: string; name: string; version?: string; size?: number }): HTMLElement {
    const open = h("button", { class: "btn sm accent", type: "button", text: "Open" });
    open.addEventListener("click", () => {
      open.disabled = true;
      void this.pullDocument(document_).finally(() => {
        open.disabled = false;
      });
    });
    const compare = h("button", { class: "btn sm", type: "button", text: "Compare" });
    compare.addEventListener("click", () => {
      compare.disabled = true;
      void this.pullDocument(document_, "compare").finally(() => {
        compare.disabled = false;
      });
    });
    return h("div", { class: "reg-row" }, [
      h("div", { class: "grow" }, [
        h("b", { text: `${document_.name}${document_.version ? ` ${document_.version}` : ""}` }),
        h("small", { text: document_.size ? `${(document_.size / 1e6).toFixed(1)} MB` : document_.guid }),
      ]),
      ...(this.actions.compareDocuments ? [compare] : []),
      open,
    ]);
  }

  private async pullDocument(
    document_: { guid: string; name: string; downloadUrl?: string },
    intent: "open" | "compare" = "open",
  ): Promise<void> {
    if (!this.actions.openDocument) {
      return void toast("This build cannot open a document from the CDE", "error");
    }
    try {
      const content = await this.client.documentContent(document_);
      await this.actions.openDocument(content.name, content.bytes, intent);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  }

  private disconnect(): void {
    this.client.disconnect();
    this.project = null;
    this.extensions = null;
    this.syncing = false;
    this.lastSync = null;
    this.setStatus("Disconnected. Cached issues remain available.");
    this.render();
  }

  private openConnectionDialog(): void {
    const dialog = h("dialog", { class: "form-dialog cde-dialog", "aria-label": "Connect an OpenCDE project" });
    const server = h("input", {
      type: "url",
      value: localStorage.getItem(LAST_SERVER_KEY) ?? "",
      placeholder: "https://cde.example.com",
      autocomplete: "url",
      "aria-label": "OpenCDE server URL",
    });
    const auth = h("select", { "aria-label": "Authentication method" });
    auth.append(
      h("option", { value: "bearer", text: "Bearer token" }),
      h("option", { value: "basic", text: "Username and password" }),
      h("option", { value: "none", text: "No credentials" }),
    );
    const token = h("input", {
      type: "password",
      placeholder: "Paste access token",
      autocomplete: "off",
      "aria-label": "Bearer token",
    });
    const username = h("input", {
      type: "text",
      placeholder: "Username",
      autocomplete: "username",
      "aria-label": "Username",
    });
    const password = h("input", {
      type: "password",
      placeholder: "Password",
      autocomplete: "current-password",
      "aria-label": "Password",
    });
    const credentials = h("div", { class: "cde-credentials" });
    const feedback = h("div", { class: "cde-feedback", role: "status" });
    const body = h("div", { class: "dlg-body cde-connect-body" }, [
      h("p", { class: "note", text: "Connect to a buildingSMART OpenCDE server and choose a BCF 3.0 project. Credentials are kept in memory for this tab only." }),
      h("label", { class: "cde-field" }, [h("span", { text: "Server" }), server]),
      h("label", { class: "cde-field" }, [h("span", { text: "Sign in with" }), auth]),
      credentials,
      feedback,
    ]);
    const cancel = h("button", { class: "btn", type: "button", text: "Cancel" });
    const connect = h("button", { class: "btn primary", type: "button", text: "Find projects" });
    let connectAction: () => void | Promise<void>;
    const foot = h("div", { class: "dlg-foot" }, [cancel, connect]);
    dialog.append(h("div", { class: "dlg-head" }, [h("span", { text: "Connect OpenCDE" })]), body, foot);

    const renderCredentials = (): void => {
      credentials.replaceChildren();
      if (auth.value === "bearer") credentials.appendChild(h("label", { class: "cde-field" }, [h("span", { text: "Access token" }), token]));
      if (auth.value === "basic") credentials.append(
        h("label", { class: "cde-field" }, [h("span", { text: "Username" }), username]),
        h("label", { class: "cde-field" }, [h("span", { text: "Password" }), password]),
      );
    };
    const readAuth = (): OpenCdeAuth => {
      if (auth.value === "none") return { kind: "none" };
      if (auth.value === "basic") return { kind: "basic", username: username.value, password: password.value };
      return { kind: "bearer", token: token.value };
    };
    const showError = (error: unknown): void => {
      feedback.classList.add("error");
      feedback.textContent = error instanceof Error ? error.message : String(error);
    };
    const chooseProject = (projects: BcfProject[]): void => {
      const preferred = localStorage.getItem(LAST_PROJECT_KEY);
      const select = h("select", { "aria-label": "OpenCDE project" });
      for (const item of projects) select.appendChild(h("option", { value: item.project_id, text: item.name }));
      if (preferred && projects.some((item) => item.project_id === preferred)) select.value = preferred;
      body.replaceChildren(
        h("div", { class: "cde-capability" }, [
          icon("check-circle", 18),
          h("div", {}, [h("strong", { text: "BCF 3.0 available" }), h("span", { text: "Choose the project to cache in this review board." })]),
        ]),
        h("label", { class: "cde-field" }, [h("span", { text: "Project" }), select]),
        feedback,
      );
      connect.textContent = "Open project";
      connect.disabled = false;
      connectAction = async (): Promise<void> => {
        const selected = projects.find((item) => item.project_id === select.value);
        if (!selected) return;
        connect.disabled = true;
        cancel.disabled = true;
        feedback.classList.remove("error");
        feedback.textContent = "Loading project issues…";
        try {
          this.project = selected;
          this.extensions = await this.client.projectExtensions(selected.project_id);
          const current = await this.client.currentUser().catch(() => null);
          if (current) this.author = current.name || current.id;
          await this.pullRemote();
          const session = this.client.getSession();
          if (session) localStorage.setItem(LAST_SERVER_KEY, session.serverUrl);
          localStorage.setItem(LAST_PROJECT_KEY, selected.project_id);
          dialog.close();
          toast(`Connected to ${selected.name}`, "success");
        } catch (error) {
          this.project = null;
          this.extensions = null;
          showError(error);
          connect.disabled = false;
          cancel.disabled = false;
        }
      };
    };
    const discover = async (trustAdvertisedOrigins = false): Promise<void> => {
      feedback.classList.remove("error");
      feedback.textContent = "Checking OpenCDE capabilities…";
      connect.disabled = true;
      try {
        await this.client.connect(server.value, readAuth(), { trustAdvertisedOrigins });
        const projects = await this.client.projects();
        if (!projects.length) throw new Error("This account has no BCF projects available.");
        chooseProject(projects);
      } catch (error) {
        showError(error);
        connect.disabled = false;
        if (error instanceof OpenCdeEndpointTrustError) {
          connect.textContent = "Trust endpoints and continue";
          connectAction = () => discover(true);
        }
      }
    };
    auth.addEventListener("change", renderCredentials);
    server.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void discover();
    });
    connectAction = () => discover();
    connect.addEventListener("click", () => void connectAction());
    cancel.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      if (!this.project) this.client.disconnect();
      dialog.remove();
    });
    renderCredentials();
    lightDismiss(dialog);
    document.body.appendChild(dialog);
    dialog.showModal();
    server.focus();
  }

  private async pullRemote(): Promise<void> {
    const active = this.activeProject();
    if (!active || !this.project) return;
    this.setStatus(`Pulling issues from ${this.project.name}…`);
    const remoteTopics = await this.client.topics(active.projectId);
    const activeTopics = this.topics.filter((topic) => this.isActiveRemote(topic));
    const cached = new Map(activeTopics.map((topic) => [topic.guid, topic]));
    const retained = activeTopics.filter((topic) => (
      topic.remote?.state !== "synced" || Boolean(topic.remote.pendingComments?.length)
    ));
    const retainedGuids = new Set(retained.map((topic) => topic.guid));
    const incoming = remoteTopics.flatMap((remote) => {
      if (retainedGuids.has(remote.guid)) return [];
      const previous = cached.get(remote.guid);
      const topic = fromBcfTopic({
        topic: remote,
        comments: previous?.comments ?? [],
        serverUrl: active.serverUrl,
        projectId: active.projectId,
        cached: previous,
      });
      if (topic.remote) topic.remote.hydrated = false;
      return [topic];
    });
    const other = this.topics.filter((topic) => !this.isActiveRemote(topic));
    this.topics = [...retained, ...incoming, ...other];
    this.lastSync = new Date();
    this.save();
    this.setStatus(`Loaded ${remoteTopics.length} project issue${remoteTopics.length === 1 ? "" : "s"}. Open one to load its comments and viewpoint.`);
    this.render();
  }

  private async hydrate(topic: Topic): Promise<void> {
    const active = this.activeProject();
    if (!active || !topic.remote || !this.isActiveRemote(topic) || topic.remote.hydrated) return;
    const remoteLink = topic.remote;
    this.setStatus(`Loading “${topic.title}”…`);
    try {
      const [comments, viewpoints] = await Promise.all([
        this.client.comments(active.projectId, topic.guid),
        this.client.viewpoints(active.projectId, topic.guid),
      ]);
      const pending = new Set(remoteLink.pendingComments ?? []);
      const queued = topic.comments.filter((comment) => pending.has(comment.guid));
      topic.comments = [
        ...comments.map((comment) => ({
          guid: comment.guid,
          date: comment.date || new Date().toISOString(),
          author: comment.author || "unknown",
          text: comment.comment ?? "",
        })),
        ...queued.filter((comment) => !comments.some((remote) => remote.guid === comment.guid)),
      ];
      const viewpoint = viewpoints[0];
      if (viewpoint) {
        topic.viewpoint = fromBcfViewpoint(viewpoint) ?? topic.viewpoint;
        const inline = viewpoint.snapshot?.snapshot_data;
        if (inline) {
          const mime = viewpoint.snapshot?.snapshot_type === "png" ? "image/png" : "image/jpeg";
          topic.snapshot = `data:${mime};base64,${inline}`;
        } else {
          const blob = await this.client.viewpointSnapshot(active.projectId, topic.guid, viewpoint.guid).catch(() => null);
          if (blob) topic.snapshot = await dataUrl(new Uint8Array(await blob.arrayBuffer()), blob.type || "image/png");
        }
      }
      remoteLink.hydrated = true;
      this.save();
      this.setStatus(`Loaded comments and viewpoint for “${topic.title}”.`);
      this.render();
      if (this.expanded === topic.guid) this.restore(topic);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error), true);
      this.renderWorkspace();
    }
  }

  private stageEdit(topic: Topic, viewDirty = false): void {
    topic.modifiedAt = new Date().toISOString();
    if (!topic.remote) return;
    if (topic.remote.state !== "pending-create") topic.remote.state = "pending-update";
    if (viewDirty) topic.remote.viewDirty = true;
    topic.remote.retryState = undefined;
    topic.remote.error = undefined;
  }

  private queueComment(topic: Topic, comment: ReviewComment): void {
    if (!topic.remote) return;
    topic.remote.pendingComments = [...new Set([...(topic.remote.pendingComments ?? []), comment.guid])];
    comment.pending = true;
    topic.remote.error = undefined;
  }

  private publish(topic: Topic): void {
    const active = this.activeProject();
    if (!active || topic.remote) return;
    topic.remote = {
      serverUrl: active.serverUrl,
      projectId: active.projectId,
      state: "pending-create",
      pendingComments: topic.comments.map((comment) => comment.guid),
      viewDirty: true,
    };
    for (const comment of topic.comments) comment.pending = true;
    this.save();
    this.setStatus(`“${topic.title}” is queued. Press Sync to publish it.`);
    this.render();
  }

  private async pushTopic(topic: Topic): Promise<void> {
    const active = this.activeProject();
    const remote = topic.remote;
    if (!active || !remote || !this.isActiveRemote(topic)) return;
    const creating = remote.state === "pending-create" || remote.retryState === "pending-create";
    const updating = remote.state === "pending-update" || remote.retryState === "pending-update";
    if (creating) {
      const created = await this.client.createTopic(active.projectId, toBcfTopic(topic, this.extensions ?? undefined));
      remote.serverAssignedId = created.server_assigned_id;
      remote.modifiedAt = created.modified_date;
      remote.state = "synced";
      remote.retryState = undefined;
      remote.pendingComments = [...new Set(topic.comments.map((comment) => comment.guid))];
      for (const comment of topic.comments) comment.pending = true;
    } else if (updating) {
      const updated = await this.client.updateTopic(active.projectId, topic.guid, toBcfTopic(topic, this.extensions ?? undefined));
      remote.serverAssignedId = updated.server_assigned_id ?? remote.serverAssignedId;
      remote.modifiedAt = updated.modified_date;
      remote.state = "synced";
      remote.retryState = undefined;
    }

    if ((creating || remote.viewDirty) && topic.viewpoint) {
      const viewpoint = toBcfViewpoint(topic);
      if (viewpoint) await this.client.createViewpoint(active.projectId, topic.guid, viewpoint);
      remote.viewDirty = false;
    }

    for (const guid of [...(remote.pendingComments ?? [])]) {
      const comment = topic.comments.find((item) => item.guid === guid);
      if (!comment) continue;
      await this.client.createComment(active.projectId, topic.guid, { guid: comment.guid, comment: comment.text });
      comment.pending = false;
      remote.pendingComments = remote.pendingComments?.filter((item) => item !== guid);
    }
    remote.state = "synced";
    remote.error = undefined;
    remote.retryState = undefined;
  }

  /**
   * One topic at a time, for the row that failed. Sync retries the whole
   * queue, which is the wrong size of action when a single title was rejected.
   */
  private async retryTopic(topic: Topic): Promise<void> {
    if (this.syncing || !this.activeProject()) return;
    this.syncing = true;
    this.renderWorkspace();
    this.setStatus(`Sending “${topic.title}”…`);
    try {
      await this.pushTopic(topic);
      this.setStatus(`Sent “${topic.title}”.`);
    } catch (error) {
      const remote = topic.remote;
      if (remote) {
        if (remote.state === "pending-create" || remote.state === "pending-update") remote.retryState = remote.state;
        remote.state = "error";
        remote.error = error instanceof Error ? error.message : String(error);
      }
      this.setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.syncing = false;
      this.save();
      this.render();
    }
  }

  private async sync(): Promise<void> {
    const active = this.activeProject();
    if (!active || this.syncing) return;
    this.syncing = true;
    this.renderWorkspace();
    this.setStatus("Sending queued changes…");
    let failures = 0;
    const queued = this.topics.filter((topic) => this.isActiveRemote(topic) && (
      topic.remote?.state !== "synced" || Boolean(topic.remote.pendingComments?.length) || topic.remote.viewDirty
    ));
    for (const topic of queued) {
      try {
        await this.pushTopic(topic);
      } catch (error) {
        failures++;
        const remote = topic.remote!;
        remote.retryState = remote.state === "pending-create" || remote.state === "pending-update" ? remote.state : undefined;
        remote.state = "error";
        remote.error = error instanceof Error ? error.message : String(error);
      }
      this.save();
      this.renderWorkspace();
    }
    try {
      await this.pullRemote();
    } catch (error) {
      failures++;
      this.setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      this.syncing = false;
      this.render();
    }
    if (failures) {
      this.setStatus(`${failures} sync operation${failures === 1 ? "" : "s"} failed. Queued changes are kept for retry.`, true);
      toast("Some OpenCDE changes could not be synced", "error");
    } else {
      this.actions.log(`Synced ${this.project?.name ?? "OpenCDE project"}`, "success");
    }
  }

  private render(): void {
    this.renderWorkspace();
    this.empty.classList.toggle("hidden", this.topics.length > 0);
    this.list.replaceChildren(...this.topics.map((topic) => this.card(topic)));
  }

  private comment(entry: ReviewComment): HTMLElement {
    return h("div", { class: "topic-comment" }, [
      h("span", { class: "who", text: `${entry.author} | ${localDate(entry.date, false)}${entry.pending ? " | queued" : ""}` }),
      h("span", { text: entry.text }),
    ]);
  }

  private card(topic: Topic): HTMLElement {
    const open = this.expanded === topic.guid;
    const remoteState = topic.remote?.state;
    const remoteLabel = remoteState === "pending-create"
      ? "Publish queued"
      : remoteState === "pending-update"
        ? "Update queued"
        : remoteState === "error"
          ? "Sync failed"
          : topic.remote
            ? topic.remote.serverAssignedId || "OpenCDE"
            : "Local";
    const head = h("button", {
      class: "topic-head",
      type: "button",
      "aria-expanded": String(open),
    }, [
      h("span", { class: `dot ${remoteState === "error" ? "err" : topic.status === "Closed" || topic.status === "Resolved" ? "ok" : ""}` }),
      h("span", { class: "grow", text: topic.title, title: topic.title }),
      h("span", { class: `topic-origin${topic.remote ? " remote" : ""}`, text: remoteLabel }),
      h("span", { class: "n", text: topic.status }),
      icon("chevron", 12),
    ]);
    head.addEventListener("click", () => {
      this.expanded = open ? null : topic.guid;
      // Only opening a topic restores its view. Closing one used to replay the
      // viewpoint as well, throwing away the camera the user had just set.
      if (!open) {
        this.restore(topic);
        void this.hydrate(topic);
      }
      this.render();
    });

    const body = h("div", { class: "topic-body" });
    if (!open) return h("div", { class: "topic" }, [head]);

    if (topic.snapshot) {
      const image = h("img", { class: "topic-shot", src: topic.snapshot, alt: "" });
      image.addEventListener("click", () => this.restore(topic));
      body.appendChild(image);
    }

    const title = h("input", { type: "text", value: topic.title, placeholder: "Title" });
    title.addEventListener("change", () => {
      topic.title = title.value.trim() || "Untitled";
      this.stageEdit(topic);
      this.save();
      this.render();
    });
    const description = h("textarea", { rows: "2", placeholder: "What is wrong here" });
    description.value = topic.description;
    description.addEventListener("change", () => {
      topic.description = description.value;
      this.stageEdit(topic);
      this.save();
      this.renderWorkspace();
    });

    const choices = (defaults: string[], server: string[] | undefined, current: string): string[] =>
      [...new Set([...(server?.length ? server : defaults), current].filter(Boolean))];
    const status = h("select");
    status.append(...choices(STATUS, this.isActiveRemote(topic) ? this.extensions?.topic_status : undefined, topic.status)
      .map((name) => h("option", { value: name, text: name })));
    status.value = topic.status;
    status.addEventListener("change", () => {
      topic.status = status.value;
      this.stageEdit(topic);
      this.save();
      this.render();
    });
    const priority = h("select");
    priority.append(...choices(PRIORITY, this.isActiveRemote(topic) ? this.extensions?.priority : undefined, topic.priority)
      .map((name) => h("option", { value: name, text: name })));
    priority.value = topic.priority;
    priority.addEventListener("change", () => {
      topic.priority = priority.value;
      this.stageEdit(topic);
      this.save();
      this.renderWorkspace();
    });

    const recapture = h("button", { class: "btn sm", type: "button", text: "Update view" });
    recapture.addEventListener("click", () => {
      const viewer = this.actions.viewer;
      topic.viewpoint = this.viewpointNow(viewer.getSelectedIds());
      this.stageEdit(topic, true);
      void snapshot(viewer).then((shot) => {
        topic.snapshot = shot;
        this.save();
        this.render();
      });
      this.save();
      this.renderWorkspace();
    });
    const remove = iconButton("trash", topic.remote ? "Remove cached issue" : "Delete issue", () => {
      confirmAction(
        topic.remote ? "Remove this cached issue?" : "Delete this issue?",
        topic.remote
          ? `"${topic.title}" is removed from this browser. The server issue is not deleted.`
          : `"${topic.title}" and its comments are removed from this browser. There is no undo.`,
        topic.remote ? "Remove cache" : "Delete",
        () => {
          this.topics = this.topics.filter((item) => item.guid !== topic.guid);
          this.save();
          this.render();
        },
      );
    }, "icon-btn sm");

    const publish = !topic.remote && this.activeProject()
      ? h("button", { class: "btn sm", type: "button", text: "Publish" })
      : null;
    publish?.addEventListener("click", () => this.publish(topic));

    const retry = h("button", { class: "btn sm", type: "button", text: "Retry", disabled: this.syncing });
    retry.addEventListener("click", () => void this.retryTopic(topic));

    let assignee: HTMLSelectElement | null = null;
    const users = this.isActiveRemote(topic)
      ? this.extensions?.user_id_type ?? this.extensions?.users ?? []
      : [];
    if (users.length) {
      assignee = h("select", { "aria-label": "Assignee", title: "Assignee" });
      assignee.appendChild(h("option", { value: "", text: "Unassigned" }));
      for (const user of choices([], users, topic.assignedTo ?? "")) {
        assignee.appendChild(h("option", { value: user, text: user }));
      }
      assignee.value = topic.assignedTo ?? "";
      assignee.addEventListener("change", () => {
        topic.assignedTo = assignee?.value || undefined;
        this.stageEdit(topic);
        this.save();
        this.renderWorkspace();
      });
    }

    const comments = h("div", { class: "topic-comments" });
    for (const comment of topic.comments) comments.appendChild(this.comment(comment));
    const draft = h("input", { type: "text", placeholder: "Add a comment", "aria-label": "Add a comment" });
    draft.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !draft.value.trim()) return;
      const comment: ReviewComment = { guid: uuid(), date: new Date().toISOString(), author: this.author, text: draft.value.trim() };
      topic.comments.push(comment);
      this.queueComment(topic, comment);
      this.save();
      this.renderWorkspace();
      // Append in place and keep the caret here: a full re-render would drop
      // the field the user is typing in, so a second comment needs a new click.
      comments.appendChild(this.comment(topic.comments[topic.comments.length - 1]));
      draft.value = "";
    });

    const controls: Node[] = [status, priority];
    if (assignee) controls.push(assignee);
    controls.push(h("span", { class: "grow" }));
    if (publish) controls.push(publish);
    controls.push(recapture, remove);
    body.append(
      title,
      description,
      h("div", { class: "row topic-controls" }, controls),
      h("div", { class: "note", text: `${topic.author} | ${localDate(topic.date, true)}${topic.assignedTo ? ` | assigned to ${topic.assignedTo}` : ""}` }),
      ...(topic.remote?.error ? [h("div", { class: "topic-sync-error" }, [
        h("span", { class: "grow", text: topic.remote.error }),
        retry,
      ])] : []),
      comments,
      draft,
    );
    return h("div", { class: "topic open" }, [head, body]);
  }
}

async function dataUrl(bytes: Uint8Array, type: string): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(new Blob([bytes as BlobPart], { type }));
  });
}
