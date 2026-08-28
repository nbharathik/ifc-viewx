// A relationship graph, and a triage pass over the docket.
//
// Retrieval over a model has been text: rank the names, hand back the best
// matches. That answers "where is the fire door" and cannot answer "which
// rooms does this duct pass through", because that is a topological question
// and there is no text in the file that states it.
//
// The parts of the answer already exist: the spatial tree is the containment
// graph, the property index is the relational view, and the batcher knows
// where everything is. This exposes them as one queryable graph, which turns
// that question from a Python script into a tool call.
import { elementsOf } from "../data/model.js";
import { modelOf } from "../viewer-core/ids.js";
import type { ModelBounds, SpatialNode, Viewer } from "../viewer-core/viewer.js";
import { docketSets } from "../results/docket.js";
import type { CapabilityDefinition, ViewerCapabilityContext } from "./types.js";

interface Node {
  id: number;
  type: string;
  name: string;
  storey: string;
}

const overlaps = (a: ModelBounds, b: ModelBounds, slack = 0): boolean =>
  a.min.x - slack <= b.max.x && a.max.x + slack >= b.min.x &&
  a.min.y - slack <= b.max.y && a.max.y + slack >= b.min.y &&
  a.min.z - slack <= b.max.z && a.max.z + slack >= b.min.z;

/** The spatial path from the project down to one element. */
function pathTo(tree: SpatialNode | null, target: number): Array<{ id: number; type: string; name: string }> {
  const path: Array<{ id: number; type: string; name: string }> = [];
  const visit = (node: SpatialNode, trail: SpatialNode[]): boolean => {
    const next = [...trail, node];
    if (node.expressID === target) {
      for (const step of next) path.push({ id: step.expressID, type: step.type, name: step.name ?? "" });
      return true;
    }
    return node.children.some((child) => visit(child, next));
  };
  if (tree) visit(tree, []);
  return path;
}

function nodesOf(viewer: Viewer): Node[] {
  return elementsOf(viewer.getSpatialTree()).map((element) => ({
    id: element.id,
    type: element.type,
    name: element.name,
    storey: element.storey,
  }));
}

export function graphCapabilities(): Array<CapabilityDefinition<Record<string, unknown>, unknown, ViewerCapabilityContext>> {
  return [
    {
      id: "graph.neighbours",
      title: "Relationships of an element",
      description:
        "The graph around one element: where it sits in the spatial structure, what shares its storey, and what it " +
        "physically touches or passes through. Use this for topology questions that no property answers.",
      input: {
        type: "object",
        properties: {
          expressId: { type: "integer", description: "The element to start from" },
          touching: { type: "boolean", description: "Include what it touches, which costs a geometry pass" },
          limit: { type: "integer", description: "How many neighbours to report, default 20" },
        },
        required: ["expressId"],
        additionalProperties: false,
      },
      effect: "read",
      permissions: [],
      cost: "instant",
      parallelSafe: true,
      exposure: { assistant: true, mcp: true, sdk: true },
      source: "core",
      presentation: { icon: "link", plain: "Read an element's relationships" },
      execute: (input, context) => {
        const id = Number(input.expressId);
        const viewer = context.viewer;
        const nodes = nodesOf(viewer);
        const self = nodes.find((node) => node.id === id);
        if (!self) throw new Error(`Element ${id} is not in the spatial structure of this model`);
        const limit = Math.max(1, Math.min(200, Number(input.limit ?? 20)));
        const path = pathTo(viewer.getSpatialTree(), id);
        const sameStorey = nodes.filter((node) => node.id !== id && node.storey === self.storey);
        const byType = new Map<string, number>();
        for (const node of sameStorey) byType.set(node.type, (byType.get(node.type) ?? 0) + 1);

        const answer: Record<string, unknown> = {
          element: self,
          model: modelOf(id),
          path,
          storeyPopulation: [...byType].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([type, count]) => ({ type, count })),
        };

        if (input.touching === true) {
          const bounds = viewer.getElementBounds(id);
          if (!bounds) {
            answer.touching = [];
            answer.note = "This element has no geometry, so nothing can be said about what it touches.";
            return answer;
          }
          const touching: Node[] = [];
          for (const node of nodes) {
            if (node.id === id || touching.length >= limit) continue;
            const other = viewer.getElementBounds(node.id);
            if (other && overlaps(bounds, other, 0.02)) touching.push(node);
          }
          answer.touching = touching;
        }
        return answer;
      },
    },
    {
      id: "graph.spaces",
      title: "Spaces an element passes through",
      description:
        "Which rooms an element runs through, by testing its geometry against every IfcSpace. This is the question " +
        "a services coordinator asks about a duct or a pipe and which no property in the file answers.",
      input: {
        type: "object",
        properties: {
          expressId: { type: "integer" },
          expressIds: { type: "array", items: { type: "integer" } },
        },
        required: [],
        additionalProperties: false,
      },
      effect: "read",
      permissions: [],
      cost: "interactive",
      parallelSafe: true,
      exposure: { assistant: true, mcp: true, sdk: true },
      source: "core",
      presentation: { icon: "layers", plain: "Find the spaces an element crosses" },
      execute: (input, context) => {
        const viewer = context.viewer;
        const ids = Array.isArray(input.expressIds)
          ? input.expressIds.map(Number).filter(Number.isFinite)
          : input.expressId !== undefined
            ? [Number(input.expressId)]
            : viewer.getSelectedIds();
        if (ids.length === 0) throw new Error("Name an element, or select one first");
        const nodes = nodesOf(viewer);
        const spaces = nodes.filter((node) => node.type === "IfcSpace");
        if (spaces.length === 0) {
          return {
            spaces: [],
            note: "This model carries no IfcSpace geometry. Turn spaces on in the View tab, or the file has none.",
          };
        }
        const spaceBounds = spaces
          .map((space) => ({ space, bounds: viewer.getElementBounds(space.id) }))
          .filter((entry): entry is { space: Node; bounds: ModelBounds } => entry.bounds !== null);
        return {
          elements: ids.map((id) => {
            const bounds = viewer.getElementBounds(id);
            const node = nodes.find((entry) => entry.id === id);
            if (!bounds) return { expressId: id, name: node?.name ?? "", spaces: [] };
            return {
              expressId: id,
              type: node?.type ?? "",
              name: node?.name ?? "",
              spaces: spaceBounds
                .filter((entry) => overlaps(bounds, entry.bounds))
                .map((entry) => ({ expressId: entry.space.id, name: entry.space.name, storey: entry.space.storey })),
            };
          }),
        };
      },
    },
    {
      id: "docket.triage",
      title: "Triage the results docket",
      description:
        "Group every open finding by what produced it and what it is about, rank the groups by how much they " +
        "matter, and propose a responsible discipline and a draft comment for each. Nothing is assigned or sent; " +
        "the reviewer approves or rejects.",
      input: {
        type: "object",
        properties: {
          set: { type: "string", description: "Which result set, by title. Blank triages all of them." },
          limit: { type: "integer", description: "How many groups to report, default 12" },
        },
        required: [],
        additionalProperties: false,
      },
      effect: "read",
      permissions: [],
      cost: "instant",
      parallelSafe: true,
      exposure: { assistant: true, mcp: false, sdk: false },
      source: "core",
      presentation: { icon: "list", plain: "Triage the findings docket" },
      execute: (input, context) => {
        const wanted = String(input.set ?? "").toLowerCase();
        const sets = docketSets().filter((set) => !wanted || set.title.toLowerCase().includes(wanted));
        if (sets.length === 0) {
          return { groups: [], note: "Nothing is on the docket. Run clash, the rules, IDS or the checks first." };
        }
        const types = context.viewer.getElementTypes();
        const groups = new Map<string, {
          producer: string;
          group: string;
          rows: number;
          errors: number;
          elements: Set<number>;
          example: string;
        }>();
        for (const set of sets) {
          for (const row of set.rows) {
            const key = `${set.title}|${row.group ?? set.title}`;
            const entry = groups.get(key) ?? {
              producer: set.title,
              group: row.group ?? set.title,
              rows: 0,
              errors: 0,
              elements: new Set<number>(),
              example: row.title,
            };
            entry.rows += 1;
            if (row.severity === "error") entry.errors += 1;
            for (const id of row.ids) entry.elements.add(id);
            groups.set(key, entry);
          }
        }
        const ranked = [...groups.values()]
          .sort((a, b) => b.errors - a.errors || b.rows - a.rows)
          .slice(0, Math.max(1, Math.min(50, Number(input.limit ?? 12))));
        return {
          groups: ranked.map((entry) => {
            const classes = [...new Set([...entry.elements].map((id) => types.get(id) ?? "").filter(Boolean))];
            return {
              producer: entry.producer,
              group: entry.group,
              findings: entry.rows,
              errors: entry.errors,
              elements: entry.elements.size,
              classes: classes.slice(0, 6),
              discipline: disciplineOf(classes),
              example: entry.example,
              draftComment:
                `${entry.rows} ${entry.group} finding${entry.rows === 1 ? "" : "s"} from ${entry.producer}, ` +
                `affecting ${entry.elements.size} element${entry.elements.size === 1 ? "" : "s"} ` +
                `(${classes.slice(0, 3).map((name) => name.replace(/^Ifc/, "")).join(", ") || "unknown classes"}). ` +
                `Example: ${entry.example}`,
            };
          }),
          note: "Proposed, not assigned. Approve a group to raise it, or reject it and it is not raised.",
        };
      },
    },
  ];
}

const MEP = ["duct", "pipe", "cable", "flow", "terminal", "valve", "pump", "tank", "heater", "electric", "sanitary"];
const STRUCTURE = ["beam", "column", "footing", "slab", "member", "plate", "pile", "reinforc"];

/** The discipline a set of classes most likely belongs to. A proposal only. */
export function disciplineOf(classes: string[]): string {
  const lower = classes.map((name) => name.toLowerCase());
  const mep = lower.filter((name) => MEP.some((token) => name.includes(token))).length;
  const structure = lower.filter((name) => STRUCTURE.some((token) => name.includes(token))).length;
  const architecture = lower.length - mep - structure;
  if (mep >= structure && mep >= architecture && mep > 0) return "MEP";
  if (structure >= architecture && structure > 0) return "Structure";
  return architecture > 0 ? "Architecture" : "Unknown";
}
