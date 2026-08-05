// Performance HUD (plain DOM), toggled with P or programmatically. Shows live
// render cost, draw calls, GPU resource counts, JS heap and the load timeline
// (download / parse / geometry / upload). Refreshes only while visible.
import { ensurePanelStyles } from './styles.js';

export interface PerfSource {
  getRendererInfo(): { geometries: number; textures: number; calls: number; triangles: number };
  getRenderTiming(): { lastMs: number; rendersLastSecond: number };
  getResolutionScale(): number;
  getLoadTimeline(): {
    downloadMs?: number;
    parseMs?: number;
    geometryMs?: number;
    uploadMs?: number;
    fileBytes?: number;
  } | null;
}

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return '-';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}

function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export class PerfHud {
  readonly root: HTMLElement;
  private readonly rows = new Map<string, HTMLElement>();
  private visible = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    container: HTMLElement,
    private readonly source: PerfSource,
  ) {
    const doc = container.ownerDocument;
    ensurePanelStyles(doc);

    this.root = doc.createElement('div');
    this.root.className = 'ifc-perf';
    this.root.setAttribute('data-testid', 'perf-hud');

    const title = doc.createElement('div');
    title.className = 'ifc-perf__title';
    title.textContent = 'Performance';
    this.root.appendChild(title);

    for (const key of [
      'render',
      'renders/s',
      'res scale',
      'draw calls',
      'triangles',
      'geometries',
      'textures',
      'JS heap',
      '',
      'file',
      'download',
      'parse',
      'geometry',
      'upload',
    ]) {
      if (!key) {
        const sep = doc.createElement('div');
        sep.className = 'ifc-perf__sep';
        this.root.appendChild(sep);
        continue;
      }
      const row = doc.createElement('div');
      row.className = 'ifc-perf__row';
      const k = doc.createElement('span');
      k.className = 'ifc-perf__key';
      k.textContent = key;
      const v = doc.createElement('span');
      v.setAttribute('data-perf', key);
      v.textContent = '-';
      row.append(k, v);
      this.root.appendChild(row);
      this.rows.set(key, v);
    }

    container.appendChild(this.root);
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.root.classList.toggle('ifc-perf--visible', visible);
    if (visible) {
      this.refresh();
      this.timer = setInterval(() => this.refresh(), 500);
    } else if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Called by the viewer after each render while visible. */
  onRender(): void {
    if (this.visible) this.refresh();
  }

  private set(key: string, value: string): void {
    const el = this.rows.get(key);
    if (el && el.textContent !== value) el.textContent = value;
  }

  refresh(): void {
    const info = this.source.getRendererInfo();
    const timing = this.source.getRenderTiming();
    this.set('render', fmtMs(timing.lastMs));
    this.set('renders/s', String(timing.rendersLastSecond));
    this.set('res scale', this.source.getResolutionScale().toFixed(2));
    this.set('draw calls', String(info.calls));
    this.set('triangles', fmtCount(info.triangles));
    this.set('geometries', String(info.geometries));
    this.set('textures', String(info.textures));

    const memory = (
      performance as unknown as { memory?: { usedJSHeapSize: number } }
    ).memory;
    this.set('JS heap', memory ? `${Math.round(memory.usedJSHeapSize / 1e6)} MB` : 'n/a');

    const timeline = this.source.getLoadTimeline();
    this.set(
      'file',
      timeline?.fileBytes !== undefined ? `${(timeline.fileBytes / 1e6).toFixed(1)} MB` : '-',
    );
    this.set('download', fmtMs(timeline?.downloadMs));
    this.set('parse', fmtMs(timeline?.parseMs));
    this.set('geometry', fmtMs(timeline?.geometryMs));
    this.set('upload', fmtMs(timeline?.uploadMs));
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.root.remove();
  }
}
