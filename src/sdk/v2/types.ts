import type { PluginCapabilities, PluginEvent, PluginInstance, ModelElement, ModelInfo } from "../types.js";
import type { ElementRow, PropertyIndex } from "../data.js";
import type { ClashOptions, SweepResult } from "../../ifc/clash.js";
import type { DistanceOptions, DistanceResult } from "../../geometry/distance.js";
import type { LaserOptions, LaserResult } from "../../geometry/laser.js";
import type { SectionAxis, SectionContourOptions, SectionContourResult } from "../../geometry/section.js";
import type { GeometrySignatureOptions, GeometrySignatureResult } from "../../geometry/signatures.js";
import type { ResultHandle, ResultOptions, ResultPage } from "../../capabilities/results.js";
import type { ReportFinding } from "../../ui/report.js";
import type {
  ItemProperties,
  CameraPose,
  Measurement,
  ModelBounds,
  SectionBox,
  SectionState,
  SpatialNode,
  ViewPreset,
  PickResult,
} from "../../viewer-core/viewer.js";
import type {
  ContributionFor,
  ContributionKind,
  ExtensionManifestV2,
} from "./contributions.js";

export interface ExtensionSessionService {
  model(): ModelInfo;
}

export interface ExtensionModelService {
  elements(): ModelElement[];
  classes(): Array<[string, number]>;
  properties(id: number): Promise<ItemProperties | null>;
  tree(): SpatialNode | null;
  subtree(id: number): number[];
  bounds(id: number): ModelBounds | null;
  index(): PropertyIndex;
  modelOf(id: number): number;
  expressOf(id: number): number;
}

export interface ExtensionGeometryService {
  clash(a: number[], b: number[], options?: ClashOptions): Promise<SweepResult>;
  distance(a: number, b: number, options?: DistanceOptions): Promise<DistanceResult>;
  laser(origin: [number, number, number], options?: LaserOptions): Promise<LaserResult>;
  sectionContours(axis: SectionAxis, offset: number, options?: SectionContourOptions): Promise<SectionContourResult>;
  signatures(ids: number[], options?: GeometrySignatureOptions): Promise<GeometrySignatureResult>;
}

export interface ExtensionViewService {
  select(ids: number | number[] | null): void;
  selection(): number[];
  lastPick(): PickResult | null;
  pickGuide(on: boolean): void;
  isVisible(id: number): boolean;
  isolate(ids: number[], label?: string): void;
  hide(ids: number[]): void;
  showAll(): void;
  frame(id?: number): void;
  frameAt(point: [number, number, number], radius?: number): void;
  viewFrom(view: ViewPreset): void;
  camera(): CameraPose;
  setCamera(pose: CameraPose): void;
  sections(): SectionState[];
  setSections(states: SectionState[]): void;
  sectionBox(): SectionBox | null;
  setSectionBox(box: SectionBox | null): void;
  boxAround(ids: number[], pad?: number): SectionBox | null;
  colorBy(assignment: Map<number, number>, colors: Array<[number, number, number]>): void;
  measurements(): Measurement[];
  addMeasurement(a: [number, number, number], b: [number, number, number]): Measurement;
  removeMeasurement(id: number): void;
}

export interface ExtensionEventService {
  on(event: PluginEvent, handler: () => void): () => void;
}

export interface ExtensionStorageService {
  read<T>(key: string, fallback: T): T;
  write(key: string, value: unknown): void;
}

export interface ExtensionFeedbackService {
  publishFindings(summary: string, findings: ReportFinding[]): void;
  log(text: string, kind?: "info" | "success" | "error"): void;
  toast(text: string, kind?: "info" | "success" | "error"): void;
}

export interface ExtensionCommandService {
  run(id: string): void;
  register(id: string, handler: () => void): () => void;
}

export interface ExtensionContributionService {
  register<Kind extends ContributionKind>(
    kind: Kind,
    contribution: ContributionFor<Kind>,
    cleanup?: () => void,
  ): () => void;
}

export interface ExtensionOverlayService {
  line(
    overlay: string,
    a: [number, number, number],
    b: [number, number, number],
  ): string;
  remove(id: string): boolean;
  clear(): void;
}

export interface ExtensionFileService {
  open(importer: string): Promise<{ name: string; mimeType: string; text: string }>;
  export(exporter: string, name: string, data: string, mimeType: string): void;
}

export type ExtensionIssuePriority = "Low" | "Normal" | "High" | "Critical";

export interface ExtensionIssueInput {
  title: string;
  description?: string;
  elementIds?: number[];
  point?: [number, number, number];
  priority?: ExtensionIssuePriority;
  metadata?: Record<string, string | number | boolean>;
}

export interface ExtensionIssueResult {
  id: string;
  title: string;
  status: "Open";
  snapshot: "pending";
}

export interface ExtensionIssueService {
  create(input: ExtensionIssueInput): Promise<ExtensionIssueResult>;
}

export interface ExtensionResultService {
  create<T>(resultView: string, items: readonly T[], options?: ResultOptions): ResultHandle;
  get(id: string): ResultHandle | null;
  page<T>(id: string, offset?: number, limit?: number): ResultPage<T>;
  dispose(id: string): boolean;
}

export interface ExtensionLocalStatus {
  state: "available" | "offline" | "missing" | "incompatible";
  providerId: string;
  expectedVersion: string;
  installedVersion?: string;
  trustedNative: true;
}

export interface ExtensionLocalService {
  status(): ExtensionLocalStatus;
  capabilities(): string[];
  invoke<T>(capability: string, input?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
}

export interface ExtensionContextV2 {
  readonly manifest: ExtensionManifestV2;
  readonly signal: AbortSignal;
  readonly session: ExtensionSessionService;
  readonly model: ExtensionModelService;
  readonly geometry: ExtensionGeometryService;
  readonly view: ExtensionViewService;
  readonly events: ExtensionEventService;
  readonly storage: ExtensionStorageService;
  readonly feedback: ExtensionFeedbackService;
  readonly commands: ExtensionCommandService;
  readonly capabilities: PluginCapabilities;
  readonly contributions: ExtensionContributionService;
  readonly overlays: ExtensionOverlayService;
  readonly files: ExtensionFileService;
  readonly issues: ExtensionIssueService;
  readonly results: ExtensionResultService;
  readonly local: ExtensionLocalService;
  close(): void;
}

export type ExtensionPanelMountV2 = (
  host: HTMLElement,
  context: ExtensionContextV2,
  payload?: unknown,
) => PluginInstance | void;

export interface ExtensionModuleV2 {
  mount: ExtensionPanelMountV2;
}

export type { ElementRow };
export type { ResultHandle, ResultOptions, ResultPage };
