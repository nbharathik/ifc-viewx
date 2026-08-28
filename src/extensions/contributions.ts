import type {
  ContributionFor,
  ContributionKind,
  ExtensionContributions,
} from "../sdk/contributions.js";

export interface RegisteredContribution<Kind extends ContributionKind = ContributionKind> {
  owner: string;
  kind: Kind;
  contribution: ContributionFor<Kind>;
}

interface StoredContribution {
  owner: string;
  kind: ContributionKind;
  contribution: { id: string };
  cleanups: Set<() => void>;
}

const contributionKey = (owner: string, id: string): string => `${owner}:${id}`;

export class ExtensionContributionRegistry {
  private readonly records = new Map<ContributionKind, Map<string, StoredContribution>>();

  register<Kind extends ContributionKind>(
    owner: string,
    kind: Kind,
    contribution: ContributionFor<Kind>,
    cleanup?: () => void,
  ): () => void {
    let entries = this.records.get(kind);
    if (!entries) {
      entries = new Map();
      this.records.set(kind, entries);
    }
    const key = contributionKey(owner, contribution.id);
    if (entries.has(key)) {
      throw new Error(`${owner} already registered ${kind}:${contribution.id}`);
    }
    const stored: StoredContribution = {
      owner,
      kind,
      contribution,
      cleanups: new Set(cleanup ? [cleanup] : []),
    };
    entries.set(key, stored);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      if (entries?.get(key) !== stored) return;
      entries.delete(key);
      for (const dispose of [...stored.cleanups].reverse()) {
        try {
          dispose();
        } catch {
          // Keep releasing the other resources owned by this contribution.
        }
      }
      stored.cleanups.clear();
    };
  }

  bind(
    owner: string,
    kind: ContributionKind,
    id: string,
    cleanup: () => void,
  ): () => void {
    const stored = this.records.get(kind)?.get(contributionKey(owner, id));
    if (!stored) throw new Error(`${owner} did not register ${kind}:${id}`);
    stored.cleanups.add(cleanup);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      stored.cleanups.delete(cleanup);
      cleanup();
    };
  }

  list<Kind extends ContributionKind>(kind: Kind): Array<RegisteredContribution<Kind>> {
    return [...(this.records.get(kind)?.values() ?? [])].map((entry) => ({
      owner: entry.owner,
      kind,
      contribution: entry.contribution as ContributionFor<Kind>,
    }));
  }

  count(owner?: string): number {
    let count = 0;
    for (const entries of this.records.values()) {
      for (const entry of entries.values()) {
        if (owner === undefined || entry.owner === owner) count += 1;
      }
    }
    return count;
  }
}

export class ExtensionScope {
  private readonly controller = new AbortController();
  private readonly disposers: Array<() => void> = [];
  private disposed = false;

  constructor(
    readonly owner: string,
    private readonly registry: ExtensionContributionRegistry,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  register<Kind extends ContributionKind>(
    kind: Kind,
    contribution: ContributionFor<Kind>,
    cleanup?: () => void,
  ): () => void {
    if (this.disposed) throw new Error(`Extension scope ${this.owner} is disposed`);
    const remove = this.registry.register(this.owner, kind, contribution, cleanup);
    this.disposers.push(remove);
    return remove;
  }

  registerManifest(contributions: ExtensionContributions): void {
    for (const [kind, entries] of Object.entries(contributions)) {
      if (!entries) continue;
      for (const contribution of entries) {
        this.register(
          kind as ContributionKind,
          contribution as ContributionFor<ContributionKind>,
        );
      }
    }
  }

  bind(kind: ContributionKind, id: string, cleanup: () => void): () => void {
    if (this.disposed) throw new Error(`Extension scope ${this.owner} is disposed`);
    const remove = this.registry.bind(this.owner, kind, id, cleanup);
    this.disposers.push(remove);
    return remove;
  }

  onDispose(dispose: () => void): void {
    if (this.disposed) {
      dispose();
      return;
    }
    this.disposers.push(dispose);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        // Cleanup is best effort, but every remaining contribution still runs.
      }
    }
  }
}
