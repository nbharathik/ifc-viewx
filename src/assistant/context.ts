import { elementCounts, modelElements } from "../llm/actions.js";
import type { Viewer } from "../viewer-core/viewer.js";
import type { ViewerContextSnapshot, ViewImageAttachment } from "./types.js";

export interface ViewerContextOptions {
  fileName: string;
  schema: string | null;
  panel: string;
  activeExtension?: string;
  activeResult?: string;
  focusedRow?: number;
  image?: ViewImageAttachment | null;
}

const round = (value: number): number => Number(value.toFixed(4));
const text = (value: unknown, limit = 160): string => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, limit);

export function modelRevision(viewer: Viewer): string {
  const models = viewer.getModels();
  const stats = viewer.getStats();
  if (!stats || models.length === 0) return "none";
  return models
    .map((model) => `${model.index}:${model.name}:${model.elements}:${model.triangles}:${model.offset.join(",")}`)
    .join("|");
}

export function buildViewerContext(viewer: Viewer, options: ViewerContextOptions): ViewerContextSnapshot {
  const stats = viewer.getStats();
  const elements = modelElements(viewer);
  const types = viewer.getElementTypes();
  const indexed = new Map(elements.map((element) => [element.id, element]));
  const camera = viewer.getCamera();
  const visibility = viewer.getVisibilityCounts();
  const counts = elementCounts(viewer);
  const recentPick = viewer.getLastPick();
  return {
    version: 1,
    revision: modelRevision(viewer),
    capturedAt: Date.now(),
    models: viewer.getModels().map((model) => ({
      index: model.index,
      name: text(model.name),
      visible: model.visible,
      elements: model.elements,
      triangles: model.triangles,
      transform: [...model.offset],
    })),
    summary: stats
      ? {
          fileName: text(options.fileName),
          schema: options.schema ? text(options.schema, 40) : null,
          entities: stats.totalEntities,
          triangles: stats.triangleCount,
          placedElements: elements.length,
          topTypes: Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([type, count]) => ({ type, count })),
        }
      : null,
    selection: viewer.getSelectedIds().slice(0, 80).map((id) => ({
      id,
      type: text(indexed.get(id)?.type ?? types.get(id) ?? "", 80),
      name: text(indexed.get(id)?.name ?? ""),
      storey: text(indexed.get(id)?.storey ?? "", 120),
    })),
    view: {
      camera: { position: camera.position.map(round), target: camera.target.map(round) },
      sections: viewer.getSections().map((section) => ({ ...section, offset: round(section.offset) })),
      sectionBox: viewer.getSectionBox(),
      plan: viewer.isPlanView(),
      visibility: {
        ...visibility,
        manualHidden: viewer.getHiddenCount(),
        rules: viewer.getRules().map((rule) => ({ label: text(rule.label), mode: rule.mode, count: rule.ids.length })),
      },
      modelsHidden: viewer.getModels().filter((model) => !model.visible).map((model) => model.index),
      ...(recentPick ? { recentPick: { expressId: recentPick.expressID, point: recentPick.point.map(round) } } : {}),
    },
    workspace: {
      panel: options.panel,
      ...(options.activeExtension ? { activeExtension: text(options.activeExtension, 120) } : {}),
      ...(options.activeResult ? { activeResult: text(options.activeResult, 120) } : {}),
      ...(options.focusedRow !== undefined ? { focusedRow: options.focusedRow } : {}),
    },
    imageAttached: Boolean(options.image),
  };
}

export function contextMessage(snapshot: ViewerContextSnapshot): string {
  return `VIEWER_CONTEXT_V1\n${JSON.stringify(snapshot)}`;
}
