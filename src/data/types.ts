export type Value = string | number | boolean | null;

export interface ModelElement {
  id: number;
  type: string;
  name: string;
  storey: string;
}

export interface ElementRow extends ModelElement {
  globalId: string;
  /** Direct IFC attributes, keyed by name. */
  attrs: Record<string, Value>;
  /** Property and quantity set values, keyed "SetName.PropertyName". */
  props: Record<string, Value>;
}

export interface XlsxOptions {
  /** Worksheet name. Excel rejects []:*?/\ and anything past 31 characters. */
  sheet?: string;
  /** Widest an auto-sized column may grow, in characters. */
  maxWidth?: number;
}
