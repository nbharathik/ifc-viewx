export type NumericVersion = [number, number, number];

export function parseNumericVersion(value: string): NumericVersion | null {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
}

export function compareNumericVersion(a: NumericVersion, b: NumericVersion): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function compatibleUpperBound(
  operator: "^" | "~",
  source: string,
  base: NumericVersion,
): NumericVersion {
  const parts = source.split(".").length;
  if (operator === "~") return parts === 1 ? [base[0] + 1, 0, 0] : [base[0], base[1] + 1, 0];
  if (base[0] > 0 || parts === 1) return [base[0] + 1, 0, 0];
  if (base[1] > 0 || parts === 2) return [0, base[1] + 1, 0];
  return [0, 0, base[2] + 1];
}
