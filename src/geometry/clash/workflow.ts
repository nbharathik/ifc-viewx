import type { ClashKind, ClashPair } from "./types.js";

export type ClashCurrentState = "new" | "unchanged" | "ignored" | "assigned";
export type ClashReviewState = ClashCurrentState | "resolved";
export type ClashGroupMode = "status" | "level" | "class" | "primary" | "proximity";

export interface ClashElementIdentity {
  id: number;
  model: number;
  globalId: string;
  type: string;
  name: string;
  storey: string;
}

export interface ClashDecision {
  state: "ignored" | "assigned";
  assignee?: string;
  note?: string;
  updatedAt: string;
}

export interface ClashIgnoreRule {
  id: string;
  aType: string;
  bType: string;
  kind?: ClashKind;
  createdAt: string;
}

export interface ClashReviewRow extends ClashPair {
  fingerprint: string;
  state: ClashCurrentState;
  assignee: string;
  aIdentity: ClashElementIdentity;
  bIdentity: ClashElementIdentity;
}

export interface ClashReviewGroup {
  key: string;
  label: string;
  rows: ClashReviewRow[];
  point?: [number, number, number];
}

const STATE_ORDER: Record<ClashCurrentState, number> = {
  new: 0,
  assigned: 1,
  unchanged: 2,
  ignored: 3,
};

function hash64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36).toUpperCase().padStart(13, "0");
}

function elementKey(identity: ClashElementIdentity): string {
  const stable = identity.globalId || `${identity.type}:${identity.id}`;
  return `${identity.model}:${stable}`;
}

export function clashClassPair(aType: string, bType: string): string {
  return [aType, bType].sort().join("|");
}

export function clashFingerprint(
  hit: ClashPair,
  a: ClashElementIdentity,
  b: ClashElementIdentity,
  grid = 0.1,
): string {
  const pair = [elementKey(a), elementKey(b)].sort().join("|");
  const point = hit.point.map((value) => Math.round(value / Math.max(0.001, grid))).join(":");
  return `CL-${hash64(`${pair}|${hit.kind}|${point}`)}`;
}

function ignoredByRule(hit: ClashPair, rules: readonly ClashIgnoreRule[]): boolean {
  const pair = clashClassPair(hit.aType, hit.bType);
  return rules.some((rule) => (
    clashClassPair(rule.aType, rule.bType) === pair && (!rule.kind || rule.kind === hit.kind)
  ));
}

export function reviewClashes(
  hits: readonly ClashPair[],
  identities: ReadonlyMap<number, ClashElementIdentity>,
  previous: ReadonlySet<string>,
  decisions: ReadonlyMap<string, ClashDecision>,
  rules: readonly ClashIgnoreRule[],
): ClashReviewRow[] {
  return hits.map((hit) => {
    const aIdentity = identities.get(hit.a) ?? {
      id: hit.a, model: 0, globalId: "", type: hit.aType, name: "", storey: "",
    };
    const bIdentity = identities.get(hit.b) ?? {
      id: hit.b, model: 0, globalId: "", type: hit.bType, name: "", storey: "",
    };
    const fingerprint = clashFingerprint(hit, aIdentity, bIdentity);
    const decision = decisions.get(fingerprint);
    const state: ClashCurrentState = decision?.state === "ignored" || ignoredByRule(hit, rules)
      ? "ignored"
      : decision?.state === "assigned"
        ? "assigned"
        : previous.has(fingerprint) ? "unchanged" : "new";
    return {
      ...hit,
      fingerprint,
      state,
      assignee: decision?.state === "assigned" ? decision.assignee ?? "" : "",
      aIdentity,
      bIdentity,
    };
  });
}

export function resolvedClashes(previous: ReadonlySet<string>, current: readonly ClashReviewRow[]): string[] {
  const live = new Set(current.map((row) => row.fingerprint));
  return [...previous].filter((fingerprint) => !live.has(fingerprint)).sort();
}

function commonLevel(row: ClashReviewRow): string {
  const a = row.aIdentity.storey;
  const b = row.bIdentity.storey;
  if (a && b && a !== b) return `${a} / ${b}`;
  return a || b || "No level";
}

function primaryLabel(row: ClashReviewRow): string {
  const identity = row.aIdentity;
  return `${identity.type.replace(/^Ifc/, "")} #${identity.id}`;
}

function proximityGroups(rows: readonly ClashReviewRow[], radius: number): ClashReviewGroup[] {
  const size = Math.max(0.25, radius);
  const buckets = new Map<string, Set<number>>();
  const groups: Array<{ rows: ClashReviewRow[]; sum: [number, number, number] }> = [];
  const sorted = [...rows].sort((a, b) => (
    a.point[0] - b.point[0] || a.point[1] - b.point[1] || a.point[2] - b.point[2] ||
    a.fingerprint.localeCompare(b.fingerprint)
  ));
  const cell = (point: [number, number, number]): [number, number, number] => [
    Math.floor(point[0] / size), Math.floor(point[1] / size), Math.floor(point[2] / size),
  ];
  const key = (x: number, y: number, z: number): string => `${x}:${y}:${z}`;

  for (const row of sorted) {
    const [cx, cy, cz] = cell(row.point);
    const candidates = new Set<number>();
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (let z = cz - 1; z <= cz + 1; z++) {
          for (const candidate of buckets.get(key(x, y, z)) ?? []) candidates.add(candidate);
        }
      }
    }
    let chosen = -1;
    let nearest = size;
    for (const candidate of candidates) {
      const group = groups[candidate];
      const count = group.rows.length;
      const center = group.sum.map((value) => value / count) as [number, number, number];
      const distance = Math.hypot(
        row.point[0] - center[0], row.point[1] - center[1], row.point[2] - center[2],
      );
      if (distance <= nearest) {
        chosen = candidate;
        nearest = distance;
      }
    }
    if (chosen < 0) {
      chosen = groups.length;
      groups.push({ rows: [], sum: [0, 0, 0] });
    }
    const group = groups[chosen];
    group.rows.push(row);
    for (let axis = 0; axis < 3; axis++) group.sum[axis] += row.point[axis];
    const bucket = buckets.get(key(cx, cy, cz)) ?? new Set<number>();
    bucket.add(chosen);
    buckets.set(key(cx, cy, cz), bucket);
  }

  return groups
    .map((group) => ({
      rows: group.rows,
      point: group.sum.map((value) => value / group.rows.length) as [number, number, number],
    }))
    .sort((a, b) => a.point[1] - b.point[1] || a.point[0] - b.point[0] || a.point[2] - b.point[2])
    .map((group, index) => ({
      key: `cluster-${index + 1}`,
      label: `Cluster ${String(index + 1).padStart(2, "0")}`,
      rows: group.rows,
      point: group.point,
    }));
}

export function groupClashes(
  rows: readonly ClashReviewRow[],
  mode: ClashGroupMode,
  proximityRadius = 2,
): ClashReviewGroup[] {
  if (mode === "proximity") return proximityGroups(rows, proximityRadius);
  const groups = new Map<string, ClashReviewRow[]>();
  for (const row of rows) {
    const key = mode === "status" ? row.state
      : mode === "level" ? commonLevel(row)
      : mode === "class" ? clashClassPair(row.aType, row.bType)
      : primaryLabel(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const label = (key: string): string => mode === "class"
    ? key.split("|").map((value) => value.replace(/^Ifc/, "")).join(" / ")
    : key[0].toUpperCase() + key.slice(1);
  return [...groups.entries()]
    .map(([key, group]) => ({ key, label: label(key), rows: group }))
    .sort((a, b) => mode === "status"
      ? STATE_ORDER[a.key as ClashCurrentState] - STATE_ORDER[b.key as ClashCurrentState]
      : b.rows.length - a.rows.length || a.label.localeCompare(b.label));
}
