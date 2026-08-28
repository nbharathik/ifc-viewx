import type { AnnotationState, CameraPose, SectionBox, SectionState } from "../viewer-core/viewer.js";
import type {
  BcfAuthorization,
  BcfComment,
  BcfProjectExtensions,
  BcfTopic,
  BcfTopicWrite,
  BcfViewpoint,
} from "./client.js";

const guid = (): string =>
  crypto.randomUUID?.() ??
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const value = (Math.random() * 16) | 0;
    return (character === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });

export interface ReviewSelection {
  id: number;
  guid: string | null;
}

export interface ReviewViewpoint {
  camera: CameraPose;
  sections: SectionState[];
  sectionBox?: SectionBox | null;
  selections?: ReviewSelection[];
  selection?: number | null;
  selectionGuid?: string | null;
  hidden: number[];
  /** Local text notes; not part of the BCF wire format, kept beside topics. */
  annotations?: AnnotationState[];
}

export interface ReviewComment {
  guid: string;
  date: string;
  author: string;
  text: string;
  pending?: boolean;
}

export type RemoteTopicState = "synced" | "pending-create" | "pending-update" | "error";

export interface RemoteTopicLink {
  serverUrl: string;
  projectId: string;
  state: RemoteTopicState;
  serverAssignedId?: string;
  modifiedAt?: string;
  pendingComments?: string[];
  viewDirty?: boolean;
  hydrated?: boolean;
  retryState?: "pending-create" | "pending-update";
  error?: string;
  authorization?: BcfAuthorization;
}

export interface ReviewTopic {
  guid: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  author: string;
  date: string;
  modifiedAt?: string;
  topicType?: string;
  assignedTo?: string;
  labels?: string[];
  stage?: string;
  dueDate?: string;
  referenceLinks?: string[];
  comments: ReviewComment[];
  viewpoint: ReviewViewpoint | null;
  snapshot: string | null;
  remote?: RemoteTopicLink;
}

const point = (value: [number, number, number]): { x: number; y: number; z: number } => ({
  x: value[0],
  y: value[1],
  z: value[2],
});

const tuple = (value: unknown): [number, number, number] | null => {
  if (!value || typeof value !== "object") return null;
  const point = value as { x?: unknown; y?: unknown; z?: unknown };
  return [point.x, point.y, point.z].every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? [point.x as number, point.y as number, point.z as number]
    : null;
};

function direction(pose: CameraPose): [number, number, number] {
  const vector: [number, number, number] = [
    pose.target[0] - pose.position[0],
    pose.target[1] - pose.position[1],
    pose.target[2] - pose.position[2],
  ];
  const length = Math.hypot(...vector) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function upVector(heading: [number, number, number]): [number, number, number] {
  const dot = heading[1];
  const up: [number, number, number] = [
    -heading[0] * dot,
    1 - heading[1] * dot,
    -heading[2] * dot,
  ];
  const length = Math.hypot(...up);
  return length < 1e-6 ? [0, 0, 1] : [up[0] / length, up[1] / length, up[2] / length];
}

function clippingPlanes(viewpoint: ReviewViewpoint): Array<{
  location: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
}> {
  if (viewpoint.sectionBox) {
    const box = viewpoint.sectionBox;
    return ([
      [0, box.min[0], 1], [0, box.max[0], -1],
      [1, box.min[1], 1], [1, box.max[1], -1],
      [2, box.min[2], 1], [2, box.max[2], -1],
    ] as Array<[number, number, number]>).map(([axis, offset, sign]) => {
      const location: [number, number, number] = [0, 0, 0];
      const normal: [number, number, number] = [0, 0, 0];
      location[axis] = offset;
      normal[axis] = sign;
      return { location: point(location), direction: point(normal) };
    });
  }
  return viewpoint.sections.map((section) => {
    const n: [number, number, number] = section.axis
      ? [section.axis === "x" ? 1 : 0, section.axis === "y" ? 1 : 0, section.axis === "z" ? 1 : 0]
      : section.normal;
    const location: [number, number, number] = [n[0] * section.offset, n[1] * section.offset, n[2] * section.offset];
    const normal: [number, number, number] = section.flip ? [n[0], n[1], n[2]] : [-n[0], -n[1], -n[2]];
    return { location: point(location), direction: point(normal) };
  });
}

function snapshotPayload(dataUrl: string | null): BcfViewpoint["snapshot"] | undefined {
  if (!dataUrl) return undefined;
  const match = /^data:image\/(png|jpeg);base64,(.+)$/i.exec(dataUrl);
  if (!match) return undefined;
  return { snapshot_type: match[1].toLowerCase() === "png" ? "png" : "jpg", snapshot_data: match[2] };
}

export function toBcfViewpoint(topic: ReviewTopic): BcfViewpoint | null {
  const view = topic.viewpoint;
  if (!view && !topic.snapshot) return null;
  if (!view) {
    return { guid: guid(), snapshot: snapshotPayload(topic.snapshot) } as BcfViewpoint;
  }
  const heading = direction(view.camera);
  const selections = view.selections ?? (
    view.selection === null || view.selection === undefined
      ? []
      : [{ id: view.selection, guid: view.selectionGuid ?? null }]
  );
  return {
    guid: guid(),
    perspective_camera: {
      camera_view_point: point(view.camera.position),
      camera_direction: point(heading),
      camera_up_vector: point(upVector(heading)),
      field_of_view: 60,
      aspect_ratio: 16 / 9,
    },
    ...(view.sections.length || view.sectionBox ? { clipping_planes: clippingPlanes(view) } : {}),
    ...(topic.snapshot ? { snapshot: snapshotPayload(topic.snapshot) } : {}),
    components: {
      selection: selections.slice(0, 1000).map((item) => ({
        ...(item.guid ? { ifc_guid: item.guid } : {}),
        originating_system: "IFCViewX",
        authoring_tool_id: String(item.id),
      })),
      visibility: {
        default_visibility: true,
        exceptions: view.hidden.slice(0, 1000).map((id) => ({
          originating_system: "IFCViewX",
          authoring_tool_id: String(id),
        })),
      },
    },
  };
}

export function fromBcfViewpoint(value: BcfViewpoint | null | undefined): ReviewViewpoint | null {
  if (!value) return null;
  const camera = value.perspective_camera ?? value.orthogonal_camera;
  if (!camera) return null;
  const position = tuple(camera.camera_view_point);
  const heading = tuple(camera.camera_direction);
  if (!position || !heading || Math.hypot(...heading) < 1e-9) return null;
  const clipping = (value.clipping_planes ?? []).flatMap((plane) => {
    const location = tuple(plane.location);
    const normal = tuple(plane.direction);
    if (!location || !normal) return [];
    const values = normal.map(Math.abs);
    const axis = values.indexOf(Math.max(...values));
    const len = Math.hypot(...normal);
    return len > 1e-9
      ? [{ axis, location, normal, axisDominant: values[axis] > 0.999 * len }]
      : [];
  });
  const axisOnly = clipping.filter((plane) => plane.axisDominant);
  const byAxis = [0, 1, 2].map((axis) => axisOnly.filter((plane) => plane.axis === axis));
  // Same interior guard as the BCF import: Directions must point inward.
  const boxLike = byAxis.every((planes) => {
    if (planes.length !== 2) return false;
    const [a, b] = [...planes].sort((p, q) => p.location[p.axis] - q.location[q.axis]);
    return a.normal[a.axis] > 0 && b.normal[b.axis] < 0;
  });
  const sectionBox = axisOnly.length === clipping.length && boxLike
    ? {
        min: byAxis.map((planes, axis) => Math.min(...planes.map((plane) => plane.location[axis]))) as [number, number, number],
        max: byAxis.map((planes, axis) => Math.max(...planes.map((plane) => plane.location[axis]))) as [number, number, number],
      }
    : null;
  const selection = value.components?.selection ?? [];
  const hidden = value.components?.visibility?.default_visibility === true
    ? value.components.visibility.exceptions ?? []
    : [];
  return {
    camera: {
      position,
      target: [position[0] + heading[0] * 10, position[1] + heading[1] * 10, position[2] + heading[2] * 10],
    },
    sections: sectionBox ? [] : clipping.map((plane) => {
      if (plane.axisDominant) {
        return {
          axis: (["x", "y", "z"] as const)[plane.axis],
          offset: plane.location[plane.axis],
          flip: plane.normal[plane.axis] > 0,
        };
      }
      const len = Math.hypot(...plane.normal) || 1;
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
    selections: selection.flatMap((component) => {
      const id = Number(component.authoring_tool_id ?? NaN);
      return Number.isFinite(id) && id > 0 ? [{ id, guid: component.ifc_guid ?? null }] : [];
    }),
    hidden: hidden.flatMap((component) => {
      const id = Number(component.authoring_tool_id ?? NaN);
      return Number.isFinite(id) && id > 0 ? [id] : [];
    }),
  };
}

function matching(value: string | undefined, choices: string[] | undefined, fallback: string): string {
  if (!choices?.length) return value || fallback;
  return choices.find((choice) => choice.toLowerCase() === value?.toLowerCase()) ?? choices[0];
}

export function toBcfTopic(topic: ReviewTopic, extensions?: BcfProjectExtensions): BcfTopicWrite {
  return {
    guid: topic.guid,
    topic_type: matching(topic.topicType, extensions?.topic_type, "Issue"),
    topic_status: matching(topic.status, extensions?.topic_status, "Open"),
    title: topic.title,
    ...(topic.priority ? { priority: matching(topic.priority, extensions?.priority, topic.priority) } : {}),
    ...(topic.description ? { description: topic.description } : {}),
    ...(topic.assignedTo ? { assigned_to: topic.assignedTo } : {}),
    ...(topic.labels?.length ? { labels: topic.labels } : {}),
    ...(topic.stage ? { stage: topic.stage } : {}),
    ...(topic.dueDate ? { due_date: topic.dueDate } : {}),
    ...(topic.referenceLinks?.length ? { reference_links: topic.referenceLinks } : {}),
  };
}

export function fromBcfTopic(options: {
  topic: BcfTopic;
  comments: BcfComment[];
  viewpoint?: BcfViewpoint | null;
  snapshot?: string | null;
  serverUrl: string;
  projectId: string;
  cached?: ReviewTopic;
}): ReviewTopic {
  const { topic, comments, serverUrl, projectId, cached } = options;
  return {
    guid: topic.guid,
    title: topic.title || "Untitled",
    description: topic.description ?? "",
    status: topic.topic_status || "Open",
    priority: topic.priority || "Normal",
    author: topic.creation_author || "unknown",
    date: topic.creation_date || cached?.date || new Date().toISOString(),
    modifiedAt: topic.modified_date,
    topicType: topic.topic_type,
    assignedTo: topic.assigned_to,
    labels: topic.labels,
    stage: topic.stage,
    dueDate: topic.due_date,
    referenceLinks: topic.reference_links,
    comments: comments.map((comment) => ({
      guid: comment.guid,
      date: comment.date || new Date().toISOString(),
      author: comment.author || "unknown",
      text: comment.comment ?? "",
    })),
    viewpoint: fromBcfViewpoint(options.viewpoint) ?? cached?.viewpoint ?? null,
    snapshot: options.snapshot ?? cached?.snapshot ?? null,
    remote: {
      serverUrl,
      projectId,
      state: "synced",
      serverAssignedId: topic.server_assigned_id,
      modifiedAt: topic.modified_date,
      hydrated: cached?.remote?.hydrated ?? false,
      authorization: topic.authorization,
    },
  };
}

export function pendingCount(topics: readonly ReviewTopic[], serverUrl: string, projectId: string): number {
  return topics.filter((topic) => (
    topic.remote?.serverUrl === serverUrl &&
    topic.remote.projectId === projectId &&
    topic.remote.state !== "synced"
  )).length + topics.reduce((sum, topic) => (
    topic.remote?.serverUrl === serverUrl && topic.remote.projectId === projectId
      ? sum + (topic.remote.pendingComments?.length ?? 0)
      : sum
  ), 0);
}
