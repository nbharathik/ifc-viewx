// What a pile of bytes actually is.
//
// Every one of these questions is asked before a model is opened, and every
// one of them has to be answered from the bytes rather than from the file
// name: a Local Studio edit comes back as real STEP under a .ifcx name, and
// trusting the extension there silently disarms the semantic engine.

/** Files over this are worth converting: threads and exact solids win. */
export const BIG_MODEL_BYTES = 50e6;

/** The IFC schema the header declares, such as IFC4, or null if it has none. */
export function sniffSchema(bytes: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  return /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(head)?.[1] ?? null;
}

/** True for a STEP physical file, whatever the name says. */
export function isStep(bytes: Uint8Array): boolean {
  return new TextDecoder("latin1").decode(bytes.subarray(0, 512)).includes("ISO-10303-21");
}

/**
 * True when the cheap STEP envelope is complete enough to hand to a parser.
 * Search backwards at byte level: valid exporters may emit large headers or
 * trailing comments, so a fixed-size hint must not become a validity rule.
 */
export function isCompleteStep(bytes: Uint8Array): boolean {
  if (!isStep(bytes)) return false;
  const marker = "END-ISO-10303-21;";
  for (let at = bytes.length - marker.length; at >= 0; at--) {
    if (bytes[at] !== marker.charCodeAt(0)) continue;
    let offset = 1;
    while (offset < marker.length && bytes[at + offset] === marker.charCodeAt(offset)) offset++;
    if (offset === marker.length) return true;
  }
  return false;
}

/** Yielding completeness check for untrusted, potentially huge input. */
export async function isCompleteStepAsync(bytes: Uint8Array): Promise<boolean> {
  if (!isStep(bytes)) return false;
  const marker = "END-ISO-10303-21;";
  const yieldEvery = 1024 * 1024;
  let sinceYield = 0;
  for (let at = bytes.length - marker.length; at >= 0; at--) {
    if (bytes[at] === marker.charCodeAt(0)) {
      let offset = 1;
      while (offset < marker.length && bytes[at + offset] === marker.charCodeAt(offset)) offset++;
      if (offset === marker.length) return true;
    }
    if (++sinceYield >= yieldEvery) {
      sinceYield = 0;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  return false;
}

/** Byte-level substring search: a 50 MB file is never decoded to find a token. */
export function containsAscii(bytes: Uint8Array, needle: string): boolean {
  const first = needle.charCodeAt(0);
  const limit = bytes.length - needle.length;
  for (let i = 0; i <= limit; i++) {
    if (bytes[i] !== first) continue;
    let k = 1;
    while (k < needle.length && bytes[i + k] === needle.charCodeAt(k)) k++;
    if (k === needle.length) return true;
  }
  return false;
}

/**
 * Whether Local Studio should be offered for this file. Big files and
 * brep-heavy ones are where the native kernel is worth the round trip; an
 * already converted container never is.
 */
export function worthConverting(bytes: Uint8Array, name: string): boolean {
  if (name.toLowerCase().endsWith(".ifcx")) return false;
  return bytes.length > BIG_MODEL_BYTES || containsAscii(bytes, "IFCADVANCEDBREP");
}

/** The same decision without monopolizing the UI thread on a near-50 MB file. */
export async function worthConvertingAsync(bytes: Uint8Array, name: string): Promise<boolean> {
  if (name.toLowerCase().endsWith(".ifcx")) return false;
  if (bytes.length > BIG_MODEL_BYTES) return true;
  const needle = "IFCADVANCEDBREP";
  const chunkBytes = 1024 * 1024;
  for (let start = 0; start < bytes.length; start += chunkBytes) {
    const end = Math.min(bytes.length, start + chunkBytes + needle.length - 1);
    if (containsAscii(bytes.subarray(start, end), needle)) return true;
    if (end < bytes.length) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return false;
}
