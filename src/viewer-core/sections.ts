export type SectionAxisName = "x" | "y" | "z";

export interface AxisSectionState {
  axis: SectionAxisName;
  offset: number;
  flip: boolean;
}

/** A scene-space plane where n . p equals offset. */
export interface PlaneSectionState {
  axis?: undefined;
  id: string;
  name: string;
  normal: [number, number, number];
  offset: number;
  flip: boolean;
}

export type SectionState = AxisSectionState | PlaneSectionState;

export interface SectionBox {
  min: [number, number, number];
  max: [number, number, number];
}

export const AXIS_NORMAL: Record<SectionAxisName, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

const AXIS_ORDER: SectionAxisName[] = ["x", "y", "z"];

export const isAxisSection = (state: SectionState): state is AxisSectionState =>
  typeof (state as AxisSectionState).axis === "string";

export const sectionKey = (state: SectionState): string =>
  isAxisSection(state) ? state.axis : state.id;

export const normalizeSectionNormal = (
  value: [number, number, number],
): [number, number, number] | null => {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(length) || length < 1e-9) return null;
  return [value[0] / length, value[1] / length, value[2] / length];
};

export function boxPlanes(box: SectionBox): AxisSectionState[] {
  const planes: AxisSectionState[] = [];
  AXIS_ORDER.forEach((axis, index) => {
    planes.push({ axis, offset: box.max[index], flip: false });
    planes.push({ axis, offset: box.min[index], flip: true });
  });
  return planes;
}

/** Grow a box so fitted elements do not sit exactly on a clipping plane. */
export function padBox(box: SectionBox, pad: number): SectionBox {
  const span = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
  const grow = Math.max(span * pad, 0.01);
  return {
    min: [box.min[0] - grow, box.min[1] - grow, box.min[2] - grow],
    max: [box.max[0] + grow, box.max[1] + grow, box.max[2] + grow],
  };
}

/** Keep every axis open by at least a sliver. */
export function sanitizeBox(box: SectionBox): SectionBox {
  const min = box.min.map((value, index) =>
    Math.min(value, box.max[index] - 1e-3),
  ) as [number, number, number];
  return { min, max: [...box.max] as [number, number, number] };
}
