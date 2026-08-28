import {
  ResultStore,
  type ResultHandle,
  type ResultOptions,
  type ResultPage,
} from "../capabilities/results.js";

const OWNER_HANDLE_LIMIT = 16;
const OWNER_ITEM_LIMIT = 10_000;

export class ExtensionResultStore {
  private readonly owners = new Map<string, string>();

  constructor(private readonly store = new ResultStore()) {}

  create<T>(owner: string, kind: string, items: readonly T[], options: ResultOptions = {}): ResultHandle {
    this.prune();
    const handles = [...this.owners]
      .filter(([, entryOwner]) => entryOwner === owner)
      .map(([id]) => this.store.get(id))
      .filter((handle): handle is ResultHandle => handle !== null);
    if (handles.length >= OWNER_HANDLE_LIMIT) throw new Error(`Extensions may keep at most ${OWNER_HANDLE_LIMIT} result handles`);
    if (handles.reduce((total, handle) => total + handle.count, 0) + items.length > OWNER_ITEM_LIMIT) {
      throw new Error(`Extensions may keep at most ${OWNER_ITEM_LIMIT} result rows`);
    }
    const handle = this.store.create(kind, items, {
      ...options,
      metadata: { ...options.metadata, extensionId: owner, resultView: kind },
    });
    this.owners.set(handle.id, owner);
    return handle;
  }

  get(owner: string, id: string): ResultHandle | null {
    if (this.owners.get(id) !== owner) return null;
    const handle = this.store.get(id);
    if (!handle) this.owners.delete(id);
    return handle;
  }

  page<T>(owner: string, id: string, offset = 0, limit = 100): ResultPage<T> {
    if (this.owners.get(id) !== owner) throw new Error(`Unknown or expired result: ${id}`);
    return this.store.page<T>(id, offset, limit);
  }

  dispose(owner: string, id: string): boolean {
    if (this.owners.get(id) !== owner) return false;
    this.owners.delete(id);
    return this.store.dispose(id);
  }

  disposeOwner(owner: string): number {
    let removed = 0;
    for (const [id, entryOwner] of [...this.owners]) {
      if (entryOwner === owner && this.dispose(owner, id)) removed += 1;
    }
    return removed;
  }

  private prune(): void {
    for (const id of this.owners.keys()) {
      if (!this.store.get(id)) this.owners.delete(id);
    }
  }
}
