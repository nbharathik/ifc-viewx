import type { GeometryIndex } from "./geometryIndex.js";
import type { GeometrySignatureResult, GeometrySignatureSpec } from "./types.js";

export interface SignatureQueryHooks {
  cancelled?(): boolean;
  yieldTurn?(): Promise<void>;
}

export async function runGeometrySignatures(
  index: GeometryIndex,
  spec: GeometrySignatureSpec,
  hooks: SignatureQueryHooks = {},
): Promise<GeometrySignatureResult> {
  const started = performance.now();
  const signatures = [];
  let missing = 0;
  let slice = performance.now();
  for (const id of spec.ids) {
    if (hooks.cancelled?.()) throw new DOMException("Geometry query cancelled", "AbortError");
    const signature = index.signature(id);
    if (signature) signatures.push(signature);
    else missing += 1;
    if (performance.now() - slice >= 8 && hooks.yieldTurn) {
      await hooks.yieldTurn();
      slice = performance.now();
    }
  }
  return {
    signatures,
    missing,
    elapsedMs: performance.now() - started,
    fidelity: "mesh",
    engine: "browser-signature",
    geometryRevision: index.revision,
  };
}
