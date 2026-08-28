export interface VisibilityRule {
  id: string;
  label: string;
  mode: "keep" | "hide";
  ids: number[];
  selector?: unknown;
}

export interface VisibilityStep {
  rules: VisibilityRule[];
  hidden: number[];
}

export const VISIBILITY_HISTORY_LIMIT = 50;

const sameIds = (first: number[], second: number[]): boolean =>
  first.length === second.length && first.every((id, index) => id === second[index]);

export function sameVisibilityStep(first: VisibilityStep, second: VisibilityStep): boolean {
  if (first.rules.length !== second.rules.length || !sameIds(first.hidden, second.hidden)) return false;
  return first.rules.every((rule, index) =>
    rule.mode === second.rules[index].mode && sameIds(rule.ids, second.rules[index].ids),
  );
}
