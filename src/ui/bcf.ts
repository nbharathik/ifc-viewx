// BCF: issues pinned to a viewpoint. Topics live in this browser beside the
// model they belong to and travel as a .bcfzip (BCF 2.1). Cameras are written
// in viewer world coordinates: they round trip here exactly, and land close in
// other tools when the model shares that origin.
import { confirmAction, h, icon, iconButton, toast } from "./kit.js";
import { emptyState } from "./shell.js";
import type { ReportIssue } from "./report.js";
import type { CameraPose, SectionState, Viewer } from "../viewer-core/viewer.js";

interface Viewpoint {
  camera: CameraPose;
  sections: SectionState[];
  selection: number | null;
  selectionGuid: string | null;
  hidden: number[];
}

interface Topic {
  guid: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  author: string;
  date: string;
  comments: Array<{ guid: string; date: string; author: string; text: string }>;
  viewpoint: Viewpoint | null;
  snapshot: string | null;
}

const STATUS = ["Open", "In Progress", "Resolved", "Closed"];
const PRIORITY = ["Low", "Normal", "High", "Critical"];
/** Snapshot width kept small: topics share one localStorage budget. */
const SNAP_WIDTH = 560;
/** Above this the hidden set is not stored; restoring then shows everything. */
const HIDDEN_LIMIT = 2000;

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

async function unzip(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let end = -1;
  for (let i = buffer.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("That file is not a zip archive.");
  const count = view.getUint16(end + 10, true);
  const decoder = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < count; i++) {
    const nameLength = view.getUint16(at + 28, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const local = view.getUint32(at + 42, true);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, raw);
    else if (method === 8) {
      const stream = new Blob([raw as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      out.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
    }
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return out;
}

// -- BCF xml ----------------------------------------------------------------
const escape = (text: string): string =>
  text.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
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
        `<Comment Guid="${comment.guid}"><Date>${comment.date}</Date><Author>${escape(comment.author)}</Author>` +
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
    `<Topic Guid="${topic.guid}" TopicType="Issue" TopicStatus="${escape(topic.status)}">` +
    `<Title>${escape(topic.title)}</Title><Priority>${escape(topic.priority)}</Priority>` +
    `<CreationDate>${topic.date}</CreationDate><CreationAuthor>${escape(topic.author)}</CreationAuthor>` +
    `<Description>${escape(topic.description)}</Description></Topic>` +
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
  const selection = view.selection === null ? "" : `<Selection>${component(view.selection, view.selectionGuid)}</Selection>`;
  const exceptions =
    view.hidden.length && view.hidden.length <= 500
      ? `<Exceptions>${view.hidden.map((id) => component(id, null)).join("")}</Exceptions>`
      : "";
  const planes = view.sections
    .map((section) => {
      const index = section.axis === "x" ? 0 : section.axis === "y" ? 1 : 2;
      const location: [number, number, number] = [0, 0, 0];
      const normal: [number, number, number] = [0, 0, 0];
      location[index] = section.offset;
      normal[index] = section.flip ? 1 : -1;
      return `<ClippingPlane>${point("Location", location)}${point("Direction", normal)}</ClippingPlane>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<VisualizationInfo Guid="${topic.guid}">` +
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
    topic.viewpoint = {
      camera: {
        position,
        target: [position[0] + heading[0] * span, position[1] + heading[1] * span, position[2] + heading[2] * span],
      },
      sections: [...view.getElementsByTagName("ClippingPlane")].flatMap((plane) => {
        const location = readVector(plane.getElementsByTagName("Location")[0] ?? null);
        const normal = readVector(plane.getElementsByTagName("Direction")[0] ?? null);
        if (!location || !normal) return [];
        const index = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
        return [{ axis: (["x", "y", "z"] as const)[index], offset: location[index], flip: normal[index] > 0 }];
      }),
      selection: Number(
        view.getElementsByTagName("Selection")[0]?.getElementsByTagName("Component")[0]?.getAttribute("AuthoringToolId") ?? NaN,
      ) || null,
      selectionGuid: null,
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
  private readonly list = h("div", { class: "scroll" });
  private readonly empty = emptyState("flag", "No issues yet", "Raise one from the current view; it keeps the camera, the section and the snapshot.");
  private readonly status = h("div", { class: "status-line" });
  private readonly file = h("input", { type: "file", accept: ".bcfzip,.zip", hidden: true });
  private readonly author = localStorage.getItem("ifcviewx.bcf.author") ?? "me";
  private topics: Topic[] = [];
  private expanded: string | null = null;

  constructor(host: HTMLElement, private readonly actions: BcfActions) {
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
        h("div", { class: "row" }, [create, h("span", { class: "grow" }), importBtn, exportBtn, this.file]),
        this.status,
        this.empty,
        this.list,
      ]),
    );

    actions.viewer.onModelLoaded(() => this.refresh());
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

  /** Raise an issue on what is on screen now. Empty title opens the editor. */
  capture(title: string, description: string): void {
    if (!this.key()) return void toast("Open a model first", "info");
    const viewer = this.actions.viewer;
    const counts = viewer.getVisibilityCounts();
    const hidden =
      counts.hidden > 0 && counts.hidden <= HIDDEN_LIMIT
        ? [...viewer.getElementTypes().keys()].filter((id) => !viewer.isElementVisible(id))
        : [];
    const topic: Topic = {
      guid: uuid(),
      title: title || "New issue",
      description,
      status: "Open",
      priority: "Normal",
      author: this.author,
      date: new Date().toISOString(),
      comments: [],
      viewpoint: {
        camera: viewer.getCamera(),
        sections: viewer.getSections(),
        selection: viewer.getSelection(),
        selectionGuid: null,
        hidden,
      },
      snapshot: null,
    };
    void snapshot(viewer).then((shot) => {
      topic.snapshot = shot;
      this.save();
      this.render();
    });
    const selected = topic.viewpoint?.selection ?? null;
    if (selected !== null) {
      void viewer.getProperties(selected).then((props) => {
        const guid = props?.attributes.find((item) => item.name === "GlobalId")?.value;
        if (guid && topic.viewpoint) {
          topic.viewpoint.selectionGuid = String(guid);
          this.save();
        }
      });
    }
    this.topics.unshift(topic);
    this.expanded = topic.guid;
    this.save();
    this.render();
    this.actions.log(`Issue raised: ${topic.title}`, "success");
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
    if (view.sections.length) viewer.setSections(view.sections);
    else viewer.clearSection();
    viewer.setCamera(view.camera);
    if (view.selection !== null) viewer.select(view.selection);
  }

  private render(): void {
    this.empty.classList.toggle("hidden", this.topics.length > 0);
    this.list.replaceChildren(...this.topics.map((topic) => this.card(topic)));
  }

  private comment(entry: { author: string; date: string; text: string }): HTMLElement {
    return h("div", { class: "topic-comment" }, [
      h("span", { class: "who", text: `${entry.author} · ${entry.date.slice(0, 10)}` }),
      h("span", { text: entry.text }),
    ]);
  }

  private card(topic: Topic): HTMLElement {
    const open = this.expanded === topic.guid;
    const head = h("button", {
      class: "topic-head",
      type: "button",
      "aria-expanded": String(open),
    }, [
      h("span", { class: `dot ${topic.status === "Closed" || topic.status === "Resolved" ? "ok" : "err"}` }),
      h("span", { class: "grow", text: topic.title, title: topic.title }),
      h("span", { class: "n", text: topic.status }),
      icon("chevron", 12),
    ]);
    head.addEventListener("click", () => {
      this.expanded = open ? null : topic.guid;
      // Only opening a topic restores its view. Closing one used to replay the
      // viewpoint as well, throwing away the camera the user had just set.
      if (!open) this.restore(topic);
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
      this.save();
      this.render();
    });
    const description = h("textarea", { rows: "2", placeholder: "What is wrong here" });
    description.value = topic.description;
    description.addEventListener("change", () => {
      topic.description = description.value;
      this.save();
    });

    const status = h("select");
    status.append(...STATUS.map((name) => h("option", { value: name, text: name })));
    status.value = topic.status;
    status.addEventListener("change", () => {
      topic.status = status.value;
      this.save();
      this.render();
    });
    const priority = h("select");
    priority.append(...PRIORITY.map((name) => h("option", { value: name, text: name })));
    priority.value = topic.priority;
    priority.addEventListener("change", () => {
      topic.priority = priority.value;
      this.save();
    });

    const recapture = h("button", { class: "btn sm", type: "button", text: "Update view" });
    recapture.addEventListener("click", () => {
      const viewer = this.actions.viewer;
      topic.viewpoint = {
        camera: viewer.getCamera(),
        sections: viewer.getSections(),
        selection: viewer.getSelection(),
        selectionGuid: null,
        hidden: [],
      };
      void snapshot(viewer).then((shot) => {
        topic.snapshot = shot;
        this.save();
        this.render();
      });
    });
    const remove = iconButton("trash", "Delete issue", () => {
      confirmAction(
        "Delete this issue?",
        `"${topic.title}" and its comments are removed from this browser. There is no undo.`,
        "Delete",
        () => {
          this.topics = this.topics.filter((item) => item.guid !== topic.guid);
          this.save();
          this.render();
        },
      );
    }, "icon-btn sm");

    const comments = h("div", { class: "topic-comments" });
    for (const comment of topic.comments) comments.appendChild(this.comment(comment));
    const draft = h("input", { type: "text", placeholder: "Add a comment", "aria-label": "Add a comment" });
    draft.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !draft.value.trim()) return;
      topic.comments.push({ guid: uuid(), date: new Date().toISOString(), author: this.author, text: draft.value.trim() });
      this.save();
      // Append in place and keep the caret here: a full re-render would drop
      // the field the user is typing in, so a second comment needs a new click.
      comments.appendChild(this.comment(topic.comments[topic.comments.length - 1]));
      draft.value = "";
    });

    body.append(
      title,
      description,
      h("div", { class: "row" }, [status, priority, h("span", { class: "grow" }), recapture, remove]),
      h("div", { class: "note", text: `${topic.author} · ${topic.date.slice(0, 16).replace("T", " ")}` }),
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
