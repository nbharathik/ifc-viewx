import type { CommandRegistry } from "../ui/commands.js";
import type { CommandPalette } from "../ui/kit.js";
import { toast } from "../ui/kit.js";

interface FileLaunchQueue {
  setConsumer(consumer: (params: { files: FileSystemFileHandle[] }) => void | Promise<void>): void;
}

export interface AppInputOptions {
  fileInput: HTMLInputElement;
  attachInput: HTMLInputElement;
  dropzone: HTMLElement;
  openFirstButton: HTMLElement;
  sampleButton: HTMLElement;
  palette: Pick<CommandPalette, "isOpen" | "toggle">;
  commands: Pick<CommandRegistry, "handleKey">;
  hasModel(): boolean;
  replaceOrConfirm(run: () => void): void;
  openFile(file: File): Promise<void>;
  attachFile(file: File): Promise<void>;
  openSample(): Promise<void>;
  showDropzone(): void;
  syncTools(): void;
  reportError(error: unknown): void;
}

const SUPPORTED_MODEL = /\.(ifc|ifcx|ifcpkg)$/i;

export function bindAppInput(options: AppInputOptions): void {
  const {
    fileInput,
    attachInput,
    dropzone,
    openFirstButton,
    sampleButton,
    palette,
    commands,
  } = options;
  const open = (file: File): void =>
    options.replaceOrConfirm(() => void options.openFile(file).catch(options.reportError));

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) open(file);
    fileInput.value = "";
  });

  const launchQueue = (globalThis as typeof globalThis & { launchQueue?: FileLaunchQueue }).launchQueue;
  launchQueue?.setConsumer(async ({ files }) => {
    const handle = files[0];
    if (!handle) return;
    try {
      const file = await handle.getFile();
      if (!SUPPORTED_MODEL.test(file.name)) throw new Error(`${file.name} is not a supported IFC file`);
      open(file);
    } catch (error) {
      options.reportError(error);
    }
  });

  attachInput.addEventListener("change", () => {
    const file = attachInput.files?.[0];
    if (file) void options.attachFile(file).catch(options.reportError);
    attachInput.value = "";
  });
  openFirstButton.addEventListener("click", () => fileInput.click());
  sampleButton.addEventListener("click", () =>
    options.replaceOrConfirm(() => void options.openSample().catch(options.reportError)),
  );

  let dragDepth = 0;
  window.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    options.showDropzone();
    dropzone.classList.add("dragging");
  });
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth !== 0) return;
    dropzone.classList.remove("dragging");
    if (options.hasModel()) dropzone.classList.add("hidden");
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove("dragging");
    if (options.hasModel()) dropzone.classList.add("hidden");
    const file = event.dataTransfer?.files?.[0];
    if (!file) return void toast("Drop an .ifc, .ifcx or .ifcpkg file", "info");
    if (!SUPPORTED_MODEL.test(file.name)) {
      return void toast(`${file.name} is not a supported IFC file`, "error");
    }
    open(file);
  });

  window.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    if (document.querySelector("dialog[open]")) return;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target?.isContentEditable === true;
    const navSurface = Boolean(target?.closest(
      "[role='menu'], [role='listbox'], [role='tree'], [role='grid']",
    ));
    const onControl = Boolean(target?.closest("button, a[href], summary, [role='button']"));
    const activates = event.key === "Enter" || event.key === " " || event.key === "Spacebar";

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      return palette.toggle();
    }
    if (event.key === "Escape") return options.syncTools();
    if (typing || navSurface || palette.isOpen()) return;
    if (onControl && activates) return;
    commands.handleKey(event);
  });
}
