export type Severity = "error" | "warning" | "info";

export interface ReportFinding {
  severity: Severity;
  title: string;
  count?: number;
  detail?: string;
}

export interface FindingSet {
  id: string;
  source: string;
  summary: string;
  findings: ReportFinding[];
}

const contributed = new Map<string, FindingSet>();

export function publishFindings(set: FindingSet): void {
  contributed.set(set.id, set);
}

export function clearFindings(id?: string): void {
  if (id === undefined) contributed.clear();
  else contributed.delete(id);
}

export function publishedFindings(): FindingSet[] {
  return [...contributed.values()];
}
