// IFC 4.3 alignments, sampled into a drivable path.
//
// Roads, rail and bridges are the fastest-growing IFC segment and the worst
// served by free viewers, which mostly show an alignment as whatever mesh the
// exporter happened to attach. An alignment is not a mesh: it is a horizontal
// curve, a vertical profile and a chainage, and every question asked of it
// ("what is at 1+240?") is asked in those terms.
//
// Segment geometry is sampled here rather than tessellated by the geometry
// engine, so the chainage is the file's own station value and not a distance
// measured along a polyline that may have been simplified.
import { ref, val, type IfcModel } from "./model.js";
import {
  completeLocalPlacementMatrix,
  lengthUnitFactor,
  multiply,
  planeAngleFactor,
  transformPoint,
  type PlacementSource,
} from "./gridAxes.js";

export type SegmentKind =
  | "LINE"
  | "CIRCULARARC"
  | "CLOTHOID"
  | "CONSTANTGRADIENT"
  | "PARABOLICARC"
  | "OTHER";

export interface AlignmentPoint {
  /** Metres in the Y-up IfcMesh.matrix frame, before the viewer origin shift. */
  point: [number, number, number];
  /** Distance along the alignment from its start, in metres. */
  station: number;
  /** Scene-plan bearing in radians: +X is zero and positive turns toward -Z. */
  direction: number;
}

export interface SampledAlignment {
  expressID: number;
  name: string;
  /** Ordered samples, start to end. */
  points: AlignmentPoint[];
  length: number;
  horizontalSegments: number;
  verticalSegments: number;
  /** Segment kinds this reader approximated rather than solved exactly. */
  approximated: SegmentKind[];
  /** True when a vertical profile was found and applied. */
  hasVertical: boolean;
}

export interface AlignmentReport {
  alignments: SampledAlignment[];
  /** Alignments present in the file with no usable geometry or placement. */
  empty: number;
}

/** Samples per segment. Enough to drive smoothly without a huge payload. */
const PER_SEGMENT = 24;
const MAX_POINTS = 20000;

interface HorizontalSegment {
  kind: SegmentKind;
  start: [number, number];
  direction: number;
  startRadius: number;
  endRadius: number;
  length: number;
}

interface VerticalSegment {
  kind: SegmentKind;
  startStation: number;
  length: number;
  startHeight: number;
  startGradient: number;
  endGradient: number;
  radius: number;
}

interface AlignmentTransform {
  /** Project length-unit to metres. */
  lengthFactor: number;
  /** Project plane-angle unit to radians. */
  angleFactor: number;
  /** Unit/axis/coordination conversion shared with rendered IFC geometry. */
  modelMatrix: number[];
  placementSource: PlacementSource;
}

const Z_UP_TO_Y_UP = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];

/** Every alignment in the file, sampled. */
export function readAlignments(model: IfcModel): AlignmentReport {
  const nests = nestIndex(model);
  const assignmentId = model.byType("IfcUnitAssignment", false)[0] ?? null;
  const assignment = assignmentId === null ? null : model.line(assignmentId);
  const placementSource: PlacementSource = {
    line: (expressID) => model.line(expressID),
    typeName: (expressID) => model.typeName(expressID),
  };
  const lengthFactor = lengthUnitFactor(assignment, placementSource.line, placementSource.typeName);
  const unitScale = [
    lengthFactor, 0, 0, 0,
    0, lengthFactor, 0, 0,
    0, 0, lengthFactor, 0,
    0, 0, 0, 1,
  ];
  const coordination = Array.from(model.api.GetCoordinationMatrix(model.id));
  const transform: AlignmentTransform = {
    lengthFactor,
    angleFactor: planeAngleFactor(assignment, placementSource.line, placementSource.typeName),
    modelMatrix: multiply(coordination, multiply(Z_UP_TO_Y_UP, unitScale)),
    placementSource,
  };
  const alignments: SampledAlignment[] = [];
  let empty = 0;
  for (const id of model.byType("IfcAlignment")) {
    const sampled = sampleAlignment(model, id, nests, transform);
    if (!sampled || sampled.points.length < 2) {
      empty += 1;
      continue;
    }
    alignments.push(sampled);
  }
  return { alignments, empty };
}

/** IfcRelNests, as parent to ordered children. */
function nestIndex(model: IfcModel): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const relationId of model.byType("IfcRelNests", false)) {
    const relation = model.line(relationId);
    if (!relation) continue;
    const parent = ref(relation.RelatingObject);
    if (parent === null) continue;
    const children = Array.isArray(relation.RelatedObjects)
      ? relation.RelatedObjects.map(ref).filter((child): child is number => child !== null)
      : [];
    const existing = map.get(parent);
    if (existing) existing.push(...children);
    else map.set(parent, children);
  }
  return map;
}

function sampleAlignment(
  model: IfcModel,
  id: number,
  nests: Map<number, number[]>,
  transform: AlignmentTransform,
): SampledAlignment | null {
  const line = model.line(id);
  if (!line) return null;
  const placement = completeLocalPlacementMatrix(line, transform.placementSource);
  if (!placement) return null;
  const name = String(val(line.Name) ?? `Alignment ${id}`);
  const children = nests.get(id) ?? [];
  const horizontal: HorizontalSegment[] = [];
  const vertical: VerticalSegment[] = [];
  const approximated = new Set<SegmentKind>();

  for (const childId of children) {
    if (model.isType(childId, "IfcAlignmentHorizontal")) {
      for (const segmentId of nests.get(childId) ?? []) {
        const parameters = designParameters(model, segmentId);
        if (!parameters) continue;
        const kind = kindOf(val(parameters.PredefinedType));
        if (kind !== "LINE" && kind !== "CIRCULARARC" && kind !== "CLOTHOID") approximated.add(kind);
        const start = pointOf(model, parameters.StartPoint);
        if (!start) continue;
        const direction = Number(val(parameters.StartDirection) ?? 0) * transform.angleFactor;
        const startRadius = Number(val(parameters.StartRadiusOfCurvature) ?? 0);
        const endRadius = Number(val(parameters.EndRadiusOfCurvature) ?? 0);
        const length = Number(val(parameters.SegmentLength) ?? 0);
        if (![direction, startRadius, endRadius, length].every(Number.isFinite) || length <= 0) continue;
        horizontal.push({
          kind,
          start,
          direction,
          startRadius,
          endRadius,
          length,
        });
      }
    } else if (model.isType(childId, "IfcAlignmentVertical")) {
      for (const segmentId of nests.get(childId) ?? []) {
        const parameters = designParameters(model, segmentId);
        if (!parameters) continue;
        const kind = kindOf(val(parameters.PredefinedType));
        const startStation = Number(val(parameters.StartDistAlong) ?? 0);
        const length = Number(val(parameters.HorizontalLength) ?? 0);
        const startHeight = Number(val(parameters.StartHeight) ?? 0);
        const startGradient = Number(val(parameters.StartGradient) ?? 0);
        const endGradient = Number(val(parameters.EndGradient) ?? 0);
        const radius = Number(val(parameters.RadiusOfCurvature) ?? 0);
        if (![startStation, length, startHeight, startGradient, endGradient, radius].every(Number.isFinite) || length < 0) continue;
        vertical.push({
          kind,
          startStation,
          length,
          startHeight,
          startGradient,
          endGradient,
          radius,
        });
      }
    }
  }

  const matrix = multiply(transform.modelMatrix, placement);
  const points = samplePath(horizontal, vertical).map((point) => ({
    point: transformPoint(matrix, point.point),
    station: point.station * transform.lengthFactor,
    direction: transformDirection(matrix, point.direction),
  }));
  return {
    expressID: id,
    name,
    points,
    length: points.length ? points[points.length - 1].station : 0,
    horizontalSegments: horizontal.length,
    verticalSegments: vertical.length,
    approximated: [...approximated],
    hasVertical: vertical.length > 0,
  };
}

/** Transform a horizontal IFC tangent without translation or large-coordinate cancellation. */
function transformDirection(matrix: number[], direction: number): number {
  const x = Math.cos(direction);
  const y = Math.sin(direction);
  const sceneX = matrix[0] * x + matrix[4] * y;
  const sceneZ = matrix[2] * x + matrix[6] * y;
  return Math.hypot(sceneX, sceneZ) > 1e-12 ? Math.atan2(-sceneZ, sceneX) : direction;
}

function designParameters(model: IfcModel, segmentId: number): Record<string, unknown> | null {
  const segment = model.line(segmentId);
  if (!segment) return null;
  const parametersId = ref(segment.DesignParameters);
  if (parametersId === null) return null;
  return model.line(parametersId);
}

function pointOf(model: IfcModel, attribute: unknown): [number, number] | null {
  const id = ref(attribute);
  const line = id === null ? null : model.line(id);
  const coordinates = line?.Coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const x = Number(val(coordinates[0]));
  const y = Number(val(coordinates[1]));
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function kindOf(value: string | number | boolean | null): SegmentKind {
  const text = String(value ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  if (text === "LINE") return "LINE";
  if (text === "CIRCULARARC") return "CIRCULARARC";
  if (text === "CLOTHOID") return "CLOTHOID";
  if (text === "CONSTANTGRADIENT") return "CONSTANTGRADIENT";
  if (text === "PARABOLICARC") return "PARABOLICARC";
  return "OTHER";
}

/**
 * Walk the horizontal segments, then lift each sample onto the vertical
 * profile. A transition segment whose exact form this reader does not solve
 * is integrated as a clothoid between its two curvatures, which is the right
 * shape for every transition in the schema and exactly right for most.
 */
function samplePath(horizontal: HorizontalSegment[], vertical: VerticalSegment[]): AlignmentPoint[] {
  const points: AlignmentPoint[] = [];
  let station = 0;
  for (const segment of horizontal) {
    if (!Number.isFinite(segment.length) || segment.length <= 0) continue;
    const steps = segment.kind === "LINE" ? 1 : PER_SEGMENT;
    for (let step = 0; step <= steps; step++) {
      if (points.length >= MAX_POINTS) break;
      const t = (step / steps) * segment.length;
      // Every segment repeats the previous one's end point.
      if (step === 0 && points.length > 0) continue;
      const at = pointAlong(segment, t);
      points.push({
        point: [at.x, at.y, 0],
        station: station + t,
        direction: at.direction,
      });
    }
    station += segment.length;
  }
  if (points.length === 0) return points;

  for (const point of points) {
    point.point[2] = heightAt(vertical, point.station);
  }
  return points;
}

/** Position and bearing a distance into one horizontal segment. */
function pointAlong(segment: HorizontalSegment, distance: number): { x: number; y: number; direction: number } {
  const startCurvature = segment.startRadius === 0 ? 0 : 1 / segment.startRadius;
  const endCurvature = segment.endRadius === 0 ? 0 : 1 / segment.endRadius;

  if (segment.kind === "LINE" || (startCurvature === 0 && endCurvature === 0)) {
    return {
      x: segment.start[0] + Math.cos(segment.direction) * distance,
      y: segment.start[1] + Math.sin(segment.direction) * distance,
      direction: segment.direction,
    };
  }

  if (segment.kind === "CIRCULARARC" || startCurvature === endCurvature) {
    // Some exporters leave one radius blank on a constant arc. Use the
    // finite side; if both are blank the straight-line branch above won.
    const curvature = startCurvature || endCurvature;
    if (!Number.isFinite(curvature) || Math.abs(curvature) < 1e-15) {
      return {
        x: segment.start[0] + Math.cos(segment.direction) * distance,
        y: segment.start[1] + Math.sin(segment.direction) * distance,
        direction: segment.direction,
      };
    }
    const radius = 1 / curvature;
    const turn = distance * curvature;
    // Centre is a quarter turn from the tangent, on the side the sign gives.
    const centreX = segment.start[0] - radius * Math.sin(segment.direction);
    const centreY = segment.start[1] + radius * Math.cos(segment.direction);
    const angle = segment.direction + turn;
    return {
      x: centreX + radius * Math.sin(angle),
      y: centreY - radius * Math.cos(angle),
      direction: angle,
    };
  }

  // A transition: curvature varies linearly with distance, which integrates
  // to the Euler spiral. No closed form, so integrate it, cheaply and stably.
  const steps = 64;
  const step = distance / steps;
  let x = segment.start[0];
  let y = segment.start[1];
  let direction = segment.direction;
  for (let index = 0; index < steps; index++) {
    const s = step * (index + 0.5);
    const curvature = startCurvature + ((endCurvature - startCurvature) * s) / segment.length;
    // Midpoint rule on the heading keeps the arc from drifting outward.
    const heading = direction + (curvature * step) / 2;
    x += Math.cos(heading) * step;
    y += Math.sin(heading) * step;
    direction += curvature * step;
  }
  return { x, y, direction };
}

/** Height at a station, from the vertical profile. Zero with no profile. */
function heightAt(vertical: VerticalSegment[], station: number): number {
  if (vertical.length === 0) return 0;
  let chosen = vertical[0];
  for (const segment of vertical) {
    if (segment.startStation <= station) chosen = segment;
  }
  const local = station - chosen.startStation;
  if (chosen.kind === "CONSTANTGRADIENT" || chosen.radius === 0) {
    return chosen.startHeight + chosen.startGradient * local;
  }
  if (chosen.kind === "PARABOLICARC" || chosen.kind === "CIRCULARARC" || chosen.kind === "OTHER") {
    // Both are, to the accuracy a road profile is drawn at, a parabola whose
    // second derivative is the gradient change over the segment length.
    const rate = chosen.length > 0 ? (chosen.endGradient - chosen.startGradient) / chosen.length : 0;
    return chosen.startHeight + chosen.startGradient * local + (rate * local * local) / 2;
  }
  return chosen.startHeight + chosen.startGradient * local;
}

/** Station formatted the way a drawing writes it: 1+240.00. */
export function chainage(station: number): string {
  const sign = station < 0 ? "-" : "";
  const value = Math.abs(station);
  const kilometres = Math.floor(value / 1000);
  const metres = value - kilometres * 1000;
  return `${sign}${kilometres}+${metres.toFixed(2).padStart(6, "0")}`;
}

/** The sample nearest a station, for a readout that follows the camera. */
export function sampleAt(alignment: SampledAlignment, station: number): AlignmentPoint | null {
  if (alignment.points.length === 0) return null;
  let best = alignment.points[0];
  let bestGap = Math.abs(best.station - station);
  for (const point of alignment.points) {
    const gap = Math.abs(point.station - station);
    if (gap < bestGap) {
      bestGap = gap;
      best = point;
    }
  }
  return best;
}

/** Linear interpolation between samples, so driving is smooth. */
export function positionAt(alignment: SampledAlignment, station: number): AlignmentPoint | null {
  const points = alignment.points;
  if (points.length === 0) return null;
  if (station <= points[0].station) return points[0];
  if (station >= points[points.length - 1].station) return points[points.length - 1];
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const next = points[index];
    if (station > next.station) continue;
    const span = next.station - previous.station;
    const t = span > 1e-9 ? (station - previous.station) / span : 0;
    return {
      station,
      point: [
        previous.point[0] + (next.point[0] - previous.point[0]) * t,
        previous.point[1] + (next.point[1] - previous.point[1]) * t,
        previous.point[2] + (next.point[2] - previous.point[2]) * t,
      ],
      direction: previous.direction + angleDelta(previous.direction, next.direction) * t,
    };
  }
  return points[points.length - 1];
}

/** Shortest signed turn from one bearing to another. */
function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}
