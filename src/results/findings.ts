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
const MAX_FINDING_SETS = 128;
const MAX_FINDINGS = 50_000;

const text = (value: unknown, label: string, max: number, required = false): string => {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw new TypeError(`Invalid finding ${label}`);
  }
  return value;
};

export function publishFindings(set: FindingSet): void {
  if (!set || typeof set !== "object" || !Array.isArray(set.findings) || set.findings.length > MAX_FINDINGS) {
    throw new TypeError(`A finding set may contain at most ${MAX_FINDINGS.toLocaleString()} rows`);
  }
  const id = text(set.id, "set id", 500, true);
  if (!contributed.has(id) && contributed.size >= MAX_FINDING_SETS) throw new Error("Too many finding producers are active");
  const findings = set.findings.map((finding): ReportFinding => {
    if (!finding || typeof finding !== "object" ||
      (finding.severity !== "error" && finding.severity !== "warning" && finding.severity !== "info")) {
      throw new TypeError("Invalid finding severity");
    }
    if (finding.count !== undefined && (!Number.isSafeInteger(finding.count) || finding.count < 0)) {
      throw new TypeError("Invalid finding count");
    }
    return {
      severity: finding.severity,
      title: text(finding.title, "title", 2_000, true),
      ...(finding.count === undefined ? {} : { count: finding.count }),
      ...(finding.detail === undefined ? {} : { detail: text(finding.detail, "detail", 20_000) }),
    };
  });
  contributed.set(id, {
    id,
    source: text(set.source, "source", 500, true),
    summary: text(set.summary, "summary", 20_000),
    findings,
  });
}

export function clearFindings(id?: string): void {
  if (id === undefined) contributed.clear();
  else contributed.delete(id);
}

export function publishedFindings(): FindingSet[] {
  return [...contributed.values()];
}
