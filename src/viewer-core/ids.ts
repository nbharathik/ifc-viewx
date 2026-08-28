// Element identity across federated models.
//
// An expressID is a STEP line number, so it is unique inside one file and
// says nothing between files: the architecture model and the services model
// both have a #1234. Federation needs an id that names both.
//
// The id stays a `number`. That is the whole design. A {model, express} object
// would break every `Set<number>`, `Map<number, ...>` and `ids.includes(id)`
// in the app, and there are well over a hundred of them, plus the whole plugin
// surface. Packing keeps value equality, so all of that code is untouched and
// stays correct.
//
// The other half of the design: model 0 packs to itself, because
// 0 * 2^32 + id === id. One open model therefore produces exactly the ids it
// produced before any of this existed, down to the default element colours,
// so the single-model path cannot regress.

/** Ids are exact to 2^53, so the model index has 21 bits above the express id. */
const SHIFT = 2 ** 32;

/** Far more disciplines than anyone federates, and still exact in a double. */
export const MAX_MODELS = 2 ** 21;

/** A STEP line number fits in 32 bits with room to spare. */
export const MAX_EXPRESS_ID = SHIFT - 1;

/**
 * Combine a model slot and an expressID into the id the whole app passes
 * around. Model 0 is the identity, so a single model is unchanged.
 */
export function packId(modelIndex: number, expressID: number): number {
  return modelIndex * SHIFT + expressID;
}

/** Which model an id belongs to. */
export function modelOf(id: number): number {
  return Math.floor(id / SHIFT);
}

/** The raw STEP line number, which is what the engine and IFC exports want. */
export function expressOf(id: number): number {
  return id - Math.floor(id / SHIFT) * SHIFT;
}

/** Group ids by their model, for anything that has to ask each engine once. */
export function byModel(ids: Iterable<number>): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const id of ids) {
    const model = modelOf(id);
    const bucket = out.get(model);
    if (bucket) bucket.push(expressOf(id));
    else out.set(model, [expressOf(id)]);
  }
  return out;
}
