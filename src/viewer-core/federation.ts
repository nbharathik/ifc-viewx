import { packId } from "./ids.js";
import type { IfcGeoReference, ModelTransform, SpatialNode } from "./engine/types.js";

export interface FederatedModel {
  index: number;
  name: string;
  visible: boolean;
  offset: [number, number, number];
  transform: ModelTransform;
  geo: IfcGeoReference;
  geoStatus: "ready" | "aligned" | "manual" | "missing" | "conflict";
  diagnostics: string[];
  elements: number;
  triangles: number;
}

export function packTree(node: SpatialNode, modelIndex: number): SpatialNode {
  if (modelIndex === 0) return node;
  return {
    ...node,
    expressID: packId(modelIndex, node.expressID),
    children: node.children.map((child) => packTree(child, modelIndex)),
  };
}
