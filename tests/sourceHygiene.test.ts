// A control character in a source file compiles and runs, so nothing catches
// it: the first symptom is grep, diff and code review quietly treating the
// file as binary and skipping it. One got into sidePanel.ts inside a template
// literal used as a Map key, where any ordinary separator would have done.
//
// Scanned by character code rather than by regex, because writing the pattern
// would mean putting the very characters this guards against into this file.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const TAB = 9;
const NEWLINE = 10;
const RETURN = 13;
const SPACE = 32;
const DELETE = 127;

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.(ts|js|css|html)$/.test(entry)) found.push(path);
  }
  return found;
}

function firstControlCharacter(text: string): { at: number; code: number } | null {
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code === TAB || code === NEWLINE || code === RETURN) continue;
    if (code < SPACE || code === DELETE) return { at, code };
  }
  return null;
}

describe("source hygiene", () => {
  it("has no control characters outside tab, newline and carriage return", () => {
    const offenders: string[] = [];
    for (const path of sources("src")) {
      const hit = firstControlCharacter(readFileSync(path, "utf8"));
      if (hit) offenders.push(`${path}: U+${hit.code.toString(16).padStart(4, "0")} at offset ${hit.at}`);
    }
    expect(offenders).toEqual([]);
  });

  it("finds one when there is one", () => {
    expect(firstControlCharacter("ok")).toBeNull();
    expect(firstControlCharacter(`a${String.fromCharCode(0)}b`)).toEqual({ at: 1, code: 0 });
  });
});
