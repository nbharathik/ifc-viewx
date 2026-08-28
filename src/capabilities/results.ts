export interface ResultHandle {
  id: string;
  capabilityId: string;
  count: number;
  createdAt: number;
  expiresAt?: number;
  revision?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ResultPage<T> {
  handle: ResultHandle;
  items: readonly T[];
  offset: number;
  limit: number;
  nextOffset: number | null;
}

export interface ResultGroup {
  key: string;
  count: number;
  ids: number[];
  rows: number[];
}

export interface ResultOptions {
  ttlMs?: number;
  revision?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

interface StoredResult {
  handle: ResultHandle;
  items: readonly unknown[];
}

export interface ResultStoreOptions {
  maxHandles?: number;
  maxItems?: number;
  maxPageSize?: number;
}

export class ResultStore {
  private readonly records = new Map<string, StoredResult>();
  private readonly maxHandles: number;
  private readonly maxItems: number;
  private readonly maxPageSize: number;
  private sequence = 0;
  private itemCount = 0;

  constructor(options: ResultStoreOptions = {}) {
    this.maxHandles = Math.max(1, options.maxHandles ?? 64);
    this.maxItems = Math.max(1, options.maxItems ?? 100_000);
    this.maxPageSize = Math.max(1, options.maxPageSize ?? 500);
  }

  create<T>(capabilityId: string, items: readonly T[], options: ResultOptions = {}): ResultHandle {
    const now = Date.now();
    const id = `result_${++this.sequence}`;
    const handle: ResultHandle = {
      id,
      capabilityId,
      count: items.length,
      createdAt: now,
      expiresAt: options.ttlMs === undefined ? undefined : now + Math.max(0, options.ttlMs),
      revision: options.revision,
      metadata: options.metadata,
    };
    this.records.set(id, { handle, items: [...items] });
    this.itemCount += items.length;
    this.evict();
    return handle;
  }

  get(id: string): ResultHandle | null {
    const record = this.live(id);
    return record?.handle ?? null;
  }

  page<T>(id: string, offset = 0, limit = 100): ResultPage<T> {
    const record = this.live(id);
    if (!record) throw new Error(`Unknown or expired result: ${id}`);
    const start = Math.max(0, Math.floor(offset));
    const size = Math.min(this.maxPageSize, Math.max(1, Math.floor(limit)));
    const end = Math.min(record.items.length, start + size);
    return {
      handle: record.handle,
      items: record.items.slice(start, end) as readonly T[],
      offset: start,
      limit: size,
      nextOffset: end < record.items.length ? end : null,
    };
  }

  group(id: string, field: string): ResultGroup[] {
    const record = this.live(id);
    if (!record) throw new Error(`Unknown or expired result: ${id}`);
    const groups = new Map<string, { ids: Set<number>; rows: number[] }>();
    record.items.forEach((item, row) => {
      const value = valueAt(item, field);
      const key = value === undefined || value === null || value === "" ? "(not set)" : String(value);
      const group = groups.get(key) ?? { ids: new Set<number>(), rows: [] };
      group.rows.push(row);
      for (const elementId of elementIds(item)) group.ids.add(elementId);
      groups.set(key, group);
    });
    return [...groups]
      .map(([key, group]) => ({ key, count: group.rows.length, ids: [...group.ids], rows: group.rows }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }

  rows<T>(id: string, indexes: readonly number[]): T[] {
    const record = this.live(id);
    if (!record) throw new Error(`Unknown or expired result: ${id}`);
    return indexes
      .filter((index) => Number.isInteger(index) && index >= 0 && index < record.items.length)
      .map((index) => record.items[index] as T);
  }

  dispose(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    this.records.delete(id);
    this.itemCount -= record.items.length;
    return true;
  }

  invalidateRevision(revision: string): number {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.handle.revision === revision && this.dispose(id)) removed += 1;
    }
    return removed;
  }

  clear(): void {
    this.records.clear();
    this.itemCount = 0;
  }

  private live(id: string): StoredResult | null {
    const record = this.records.get(id);
    if (!record) return null;
    if (record.handle.expiresAt !== undefined && record.handle.expiresAt <= Date.now()) {
      this.dispose(id);
      return null;
    }
    return record;
  }

  private evict(): void {
    for (const [id, record] of this.records) {
      if (record.handle.expiresAt !== undefined && record.handle.expiresAt <= Date.now()) this.dispose(id);
    }
    while (this.records.size > this.maxHandles || this.itemCount > this.maxItems) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (!oldest) break;
      this.dispose(oldest);
    }
  }
}

function valueAt(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function elementIds(value: unknown): number[] {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  const candidates = [row.id, row.expressId, row.expressID];
  for (const side of [row.a, row.b]) {
    if (side && typeof side === "object") candidates.push((side as Record<string, unknown>).id);
    else candidates.push(side);
  }
  return candidates
    .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry) && entry > 0);
}
