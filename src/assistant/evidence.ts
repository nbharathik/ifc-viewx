import type { ResultHandle } from "../capabilities/results.js";
import type { EvidenceKind, EvidenceReference } from "./types.js";

function idsOf(row: unknown): number[] {
  if (!row || typeof row !== "object") return [];
  const value = row as Record<string, unknown>;
  const candidates: unknown[] = [value.id, value.expressId, value.expressID];
  if (Array.isArray(value.ids)) candidates.push(...value.ids);
  if (Array.isArray(value.elementIds)) candidates.push(...value.elementIds);
  for (const side of [value.a, value.b]) {
    candidates.push(side && typeof side === "object" ? (side as Record<string, unknown>).id : side);
  }
  return candidates.filter((id): id is number => typeof id === "number" && Number.isFinite(id) && id > 0);
}

function kindOf(capabilityId: string, row: unknown): EvidenceKind {
  if (capabilityId === "clash" || capabilityId.includes("clash")) return "clash";
  if (capabilityId === "check" || capabilityId === "ids") return "check";
  if (capabilityId === "distance" || capabilityId === "laser") return "measurement";
  if (capabilityId === "properties") return "property";
  if (capabilityId === "issue.stage") return "issue";
  return idsOf(row).length ? "element" : "result";
}

function labelOf(kind: EvidenceKind, row: unknown, index: number, capabilityId: string): string {
  if (!row || typeof row !== "object") return `Result row ${index + 1}`;
  const value = row as Record<string, unknown>;
  if (kind === "clash") {
    const a = value.a && typeof value.a === "object" ? (value.a as Record<string, unknown>).id : value.a;
    const b = value.b && typeof value.b === "object" ? (value.b as Record<string, unknown>).id : value.b;
    return `Clash ${String(a ?? "?")} to ${String(b ?? "?")}`;
  }
  if (kind === "measurement" && typeof value.axis === "string") {
    const side = Number(value.direction) < 0 ? "negative" : "positive";
    return `${value.axis.toUpperCase()} ${side} axis to #${String(value.id ?? "?")}`;
  }
  const id = idsOf(row)[0];
  if (capabilityId === "sectionContours" && id) {
    const sectionName = typeof value.name === "string" && value.name ? value.name : typeof value.type === "string" ? value.type : "Element";
    return `Section ${sectionName} #${id}`;
  }
  if (typeof value.key === "string") return `${value.key} (${Number(value.count) || 0})`;
  const name = typeof value.name === "string" && value.name ? value.name : typeof value.type === "string" ? value.type : "Element";
  return id ? `${name} #${id}` : `Result row ${index + 1}`;
}

export function evidenceForRows(
  capabilityId: string,
  rows: readonly unknown[],
  handle: ResultHandle | undefined,
  nextId: () => string,
  offset = 0,
): EvidenceReference[] {
  return rows.slice(0, 24).map((row, index) => {
    const kind = kindOf(capabilityId, row);
    const record = row && typeof row === "object" ? row as Record<string, unknown> : null;
    const pointValue = record && (Array.isArray(record.at) ? record.at : Array.isArray(record.point) ? record.point : null);
    const point = pointValue
      ? pointValue as [number, number, number]
      : undefined;
    return {
      id: nextId(),
      kind,
      label: labelOf(kind, row, offset + index, capabilityId),
      capabilityId,
      ...(handle ? { resultId: handle.id, row: offset + index } : {}),
      ...(idsOf(row).length ? { elementIds: idsOf(row) } : {}),
      ...(point ? { point } : {}),
    };
  });
}

export function evidenceFooter(evidence: readonly EvidenceReference[]): string {
  if (evidence.length === 0) return "";
  return `\nEvidence references: ${evidence.map((entry) => `[${entry.id}] ${entry.label}`).join("; ")}. Cite these ids in the answer.`;
}
