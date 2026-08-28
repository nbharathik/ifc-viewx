// BM25 over the model, so the assistant searches instead of being handed a
// table. One posting list per term, built once per spatial tree and thrown
// away with it. Everything is local: no embeddings, no network, no worker.
//
// The document for an element is its class, name, storey and, when the caller
// has already read them, its property values. That is the text a person types
// when they ask for something, which is the whole point of ranking it.
import type { ModelElement as IndexedElement } from "../data/model.js";

/** Saturation and length normalisation. The usual defaults; nothing tuned. */
const K1 = 1.5;
const B = 0.75;
/** Terms shorter than this carry no signal and blow up the posting lists. */
const MIN_TERM = 2;

export interface SearchHit {
  id: number;
  type: string;
  name: string;
  storey: string;
  score: number;
}

export interface Bm25Index {
  size: number;
  search(query: string, limit: number): SearchHit[];
}

/**
 * Words, lowercased, with the separators BIM names actually use. `IfcWallStandardCase`
 * also yields `wall`, `standard` and `case`, so "wall" finds it without the
 * caller knowing the class name.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (lower.length >= MIN_TERM) out.push(lower);
    // Split camel case and letter/digit runs as well, but keep the whole word
    // too: "standardcase" and "standard" should both land, and so should
    // "1200" against a "1200x1500" size in a family name.
    const parts = raw.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=\d)(?=[A-Za-z])|(?<=[A-Za-z])(?=\d)/);
    if (parts.length < 2) continue;
    for (const part of parts) {
      const piece = part.toLowerCase();
      if (piece.length >= MIN_TERM && piece !== lower) out.push(piece);
    }
  }
  return out;
}

/** Extra searchable text per element, keyed by expressID. */
export type TextSource = (element: IndexedElement) => string | undefined;

export function buildIndex(elements: IndexedElement[], extra?: TextSource): Bm25Index {
  const postings = new Map<string, Map<number, number>>();
  const lengths = new Float64Array(elements.length);
  let total = 0;

  elements.forEach((element, doc) => {
    const text = `${element.type} ${element.name} ${element.storey} ${extra?.(element) ?? ""}`;
    const terms = tokenize(text);
    lengths[doc] = terms.length;
    total += terms.length;
    for (const term of terms) {
      let list = postings.get(term);
      if (!list) postings.set(term, (list = new Map()));
      list.set(doc, (list.get(doc) ?? 0) + 1);
    }
  });

  const avg = elements.length ? total / elements.length : 0;

  return {
    size: elements.length,
    search(query: string, limit: number): SearchHit[] {
      const terms = [...new Set(tokenize(query))];
      if (terms.length === 0 || elements.length === 0) return [];
      const scores = new Map<number, number>();
      for (const term of terms) {
        const list = postings.get(term);
        if (!list) continue;
        // Standard BM25 idf, floored at zero: a term in nearly every document
        // goes negative otherwise and pushes matches below non-matches.
        const idf = Math.max(
          0,
          Math.log(1 + (elements.length - list.size + 0.5) / (list.size + 0.5)),
        );
        if (idf === 0) continue;
        for (const [doc, freq] of list) {
          const norm = avg > 0 ? 1 - B + (B * lengths[doc]) / avg : 1;
          scores.set(doc, (scores.get(doc) ?? 0) + (idf * freq * (K1 + 1)) / (freq + K1 * norm));
        }
      }
      return [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.max(1, limit))
        .map(([doc, score]) => ({
          id: elements[doc].id,
          type: elements[doc].type,
          name: elements[doc].name,
          storey: elements[doc].storey,
          score: Number(score.toFixed(3)),
        }));
    },
  };
}
