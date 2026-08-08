import type { CameraPose, SectionBox, SectionState, Viewer, VisibilityRule } from "../viewer-core/viewer.js";

interface ViewSnapshot {
  camera: CameraPose;
  selection: number[];
  rules: VisibilityRule[];
  hidden: number[];
  sections: SectionState[];
  sectionBox: SectionBox | null;
  plan: boolean;
  models: Array<{ index: number; visible: boolean }>;
  categories: { spaces: boolean; openings: boolean };
  measurements: number[];
}

export interface ViewTransaction {
  id: string;
  label: string;
  restore(): void;
}

function snapshot(viewer: Viewer): ViewSnapshot {
  return {
    camera: viewer.getCamera(),
    selection: viewer.getSelectedIds(),
    rules: viewer.getRules().map((rule) => ({ ...rule, ids: [...rule.ids] })),
    hidden: viewer.getHiddenIds(),
    sections: viewer.getSections(),
    sectionBox: viewer.getSectionBox(),
    plan: viewer.isPlanView(),
    models: viewer.getModels().map((model) => ({ index: model.index, visible: model.visible })),
    categories: {
      spaces: viewer.isCategoryVisible("IfcSpace"),
      openings: viewer.isCategoryVisible("IfcOpeningElement"),
    },
    measurements: viewer.getMeasurements().map((measurement) => measurement.id),
  };
}

function restore(viewer: Viewer, state: ViewSnapshot): void {
  viewer.showAll();
  for (const rule of state.rules) viewer.addRule({ label: rule.label, mode: rule.mode, ids: [...rule.ids] });
  if (state.hidden.length) viewer.setHidden(state.hidden, true);
  for (const model of state.models) viewer.setModelVisible(model.index, model.visible);
  void viewer.setCategoryVisible("IfcSpace", state.categories.spaces);
  void viewer.setCategoryVisible("IfcOpeningElement", state.categories.openings);
  if (state.sectionBox) viewer.setSectionBox(state.sectionBox);
  else viewer.setSections(state.sections);
  viewer.setPlanView(state.plan);
  viewer.selectMany(state.selection, "replace");
  const keep = new Set(state.measurements);
  for (const measurement of viewer.getMeasurements()) {
    if (!keep.has(measurement.id)) viewer.removeMeasurement(measurement.id);
  }
  viewer.setCamera(state.camera);
}

export class ViewTransactionManager {
  private sequence = 0;

  constructor(private readonly viewer: Viewer) {}

  begin(label: string): ViewTransaction {
    const state = snapshot(this.viewer);
    let live = true;
    return {
      id: `view_${++this.sequence}`,
      label,
      restore: () => {
        if (!live) return;
        live = false;
        restore(this.viewer, state);
      },
    };
  }
}
