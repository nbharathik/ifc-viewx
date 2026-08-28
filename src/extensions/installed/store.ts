import type { InstalledExtensionRecord } from "./types.js";

export interface InstalledExtensionStore {
  list(): Promise<InstalledExtensionRecord[]>;
  readPackage(id: string, packageFile: string): Promise<Uint8Array>;
  save(record: InstalledExtensionRecord, packageFile: string, bytes: Uint8Array): Promise<void>;
  writeState(record: InstalledExtensionRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type IterableDirectory = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

function validRecord(value: unknown): value is InstalledExtensionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<InstalledExtensionRecord>;
  return typeof record.id === "string" && typeof record.enabled === "boolean" &&
    typeof record.activeHash === "string" && Array.isArray(record.versions);
}

async function readFile(directory: FileSystemDirectoryHandle, name: string): Promise<Uint8Array> {
  const handle = await directory.getFileHandle(name);
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

async function writeFile(directory: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes as Uint8Array<ArrayBuffer>);
  await writable.close();
}

export class OpfsExtensionStore implements InstalledExtensionStore {
  private root: Promise<FileSystemDirectoryHandle> | null = null;

  async list(): Promise<InstalledExtensionRecord[]> {
    const root = await this.directory();
    const records: InstalledExtensionRecord[] = [];
    for await (const [name, handle] of (root as IterableDirectory).entries()) {
      if (handle.kind !== "directory") continue;
      try {
        const directory = await root.getDirectoryHandle(name);
        const parsed: unknown = JSON.parse(decoder.decode(await readFile(directory, "state.json")));
        if (validRecord(parsed)) records.push(parsed);
      } catch {
        // A partial or manually damaged entry stays inert instead of blocking startup.
      }
    }
    return records;
  }

  async readPackage(id: string, packageFile: string): Promise<Uint8Array> {
    const directory = await (await this.directory()).getDirectoryHandle(id);
    return readFile(directory, packageFile);
  }

  async save(
    record: InstalledExtensionRecord,
    packageFile: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const directory = await (await this.directory()).getDirectoryHandle(record.id, { create: true });
    await writeFile(directory, packageFile, bytes);
    await this.writeRecord(directory, record);
    await this.removeUnusedPackages(directory, record);
  }

  async writeState(record: InstalledExtensionRecord): Promise<void> {
    const directory = await (await this.directory()).getDirectoryHandle(record.id, { create: true });
    await this.writeRecord(directory, record);
  }

  async remove(id: string): Promise<void> {
    await (await this.directory()).removeEntry(id, { recursive: true });
  }

  private async directory(): Promise<FileSystemDirectoryHandle> {
    this.root ??= navigator.storage.getDirectory()
      .then((root) => root.getDirectoryHandle("ifcviewx-extensions", { create: true }));
    return this.root;
  }

  private writeRecord(directory: FileSystemDirectoryHandle, record: InstalledExtensionRecord): Promise<void> {
    return writeFile(directory, "state.json", encoder.encode(JSON.stringify(record)));
  }

  private async removeUnusedPackages(
    directory: FileSystemDirectoryHandle,
    record: InstalledExtensionRecord,
  ): Promise<void> {
    const keep = new Set(record.versions.map((version) => version.packageFile));
    for await (const [name, handle] of (directory as IterableDirectory).entries()) {
      if (handle.kind === "file" && name !== "state.json" && !keep.has(name)) {
        await directory.removeEntry(name);
      }
    }
  }
}

export class MemoryExtensionStore implements InstalledExtensionStore {
  private readonly records = new Map<string, InstalledExtensionRecord>();
  private readonly packages = new Map<string, Uint8Array>();

  async list(): Promise<InstalledExtensionRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async readPackage(id: string, packageFile: string): Promise<Uint8Array> {
    const bytes = this.packages.get(`${id}:${packageFile}`);
    if (!bytes) throw new Error(`Missing installed package ${id}:${packageFile}`);
    return bytes.slice();
  }

  async save(record: InstalledExtensionRecord, packageFile: string, bytes: Uint8Array): Promise<void> {
    this.packages.set(`${record.id}:${packageFile}`, bytes.slice());
    await this.writeState(record);
    const keep = new Set(record.versions.map((version) => `${record.id}:${version.packageFile}`));
    for (const key of this.packages.keys()) if (key.startsWith(`${record.id}:`) && !keep.has(key)) this.packages.delete(key);
  }

  async writeState(record: InstalledExtensionRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
    for (const key of this.packages.keys()) if (key.startsWith(`${id}:`)) this.packages.delete(key);
  }
}

export function browserExtensionStore(): InstalledExtensionStore {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function"
    ? new OpfsExtensionStore()
    : new MemoryExtensionStore();
}
