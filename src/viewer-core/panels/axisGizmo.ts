// Orientation gizmo: a small 2D canvas triad in the corner of the viewport.
// The world axes are projected straight from nine elements of the camera
// matrix, so a repaint is a dozen canvas ops with no allocation and no second
// GL context. It only repaints when the orientation actually changed. Clicking
// an axis end swings the camera onto it, keeping target and distance.
import type { CameraPose } from '../scene/scene.js';
import { ensurePanelStyles } from './styles.js';

/** All the gizmo reads, so three stays out of this file. */
interface CameraLike {
  matrixWorld: { elements: ArrayLike<number> };
}

export interface AxisGizmoHost {
  getPose(): CameraPose;
  setPose(pose: CameraPose): void;
}

interface AxisEnd {
  /** axis * 2 + (negative ? 1 : 0); stable while `ends` is depth sorted. */
  id: number;
  axis: number;
  sign: number;
  x: number;
  y: number;
  /** 1 points at the viewer, -1 away. */
  depth: number;
}

const SIZE = 68;
const RADIUS = 24;
const DOT = 7.6;
const TAU = Math.PI * 2;
const LABELS = ['X', 'Y', 'Z'];
const COLORS = ['#e5484d', '#30a46c', '#3b82f6'];
const RING = 'rgba(140, 148, 160, 0.28)';
const SNAP_MS = 260;
/** Keeps a straight up or down view off the orbit pole. */
const NUDGE = 0.0016;

const byDepth = (a: AxisEnd, b: AxisEnd): number => a.depth - b.depth;

export class AxisGizmo {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly font: string;
  /** Camera basis rows: right, up, back, each dotted with the world axes. */
  private readonly basis = new Float64Array(9);
  private readonly ends: AxisEnd[] = [];
  private hover = -1;
  private dpr = 0;
  private frame = 0;
  /** Pose the running snap last wrote; drift from it means the user took over. */
  private expected: CameraPose | null = null;

  constructor(
    container: HTMLElement,
    private readonly camera: CameraLike,
    private readonly host: AxisGizmoHost,
  ) {
    const doc = container.ownerDocument;
    ensurePanelStyles(doc);

    this.canvas = doc.createElement('canvas');
    this.canvas.className = 'ifc-axis-gizmo';
    this.canvas.setAttribute('data-testid', 'axis-gizmo');
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;
    this.font = `700 9px ${
      getComputedStyle(container).getPropertyValue('--ifc-font').trim() || 'system-ui, sans-serif'
    }`;

    for (let axis = 0; axis < 3; axis++) {
      for (const sign of [1, -1]) {
        this.ends.push({ id: axis * 2 + (sign > 0 ? 0 : 1), axis, sign, x: 0, y: 0, depth: 0 });
      }
    }

    this.canvas.addEventListener('pointermove', (e) => this.setHover(this.endAt(e)));
    this.canvas.addEventListener('pointerleave', () => this.setHover(-1));
    this.canvas.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.canvas.addEventListener('click', (e) => {
      const id = this.endAt(e);
      if (id >= 0) this.snapTo(id);
    });

    container.appendChild(this.canvas);
    this.sync();
  }

  /** Called after every render; repaints only on an orientation change. */
  sync(): void {
    const m = this.camera.matrixWorld.elements;
    let changed = false;
    for (let row = 0; row < 3; row++) {
      for (let axis = 0; axis < 3; axis++) {
        const value = m[row * 4 + axis];
        if (this.basis[row * 3 + axis] !== value) {
          this.basis[row * 3 + axis] = value;
          changed = true;
        }
      }
    }
    if (changed) this.paint();
  }

  private setHover(id: number): void {
    if (id === this.hover) return;
    this.hover = id;
    this.canvas.style.cursor = id >= 0 ? 'pointer' : '';
    this.canvas.title = id >= 0 ? `Look along ${id % 2 === 0 ? '+' : '-'}${LABELS[id >> 1]}` : '';
    this.paint();
  }

  /** Front-most end under the pointer, or -1. */
  private endAt(e: MouseEvent): number {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    for (let i = this.ends.length - 1; i >= 0; i--) {
      const end = this.ends[i];
      if (Math.hypot(end.x - px, end.y - py) <= DOT + 2) return end.id;
    }
    return -1;
  }

  private paint(): void {
    const dpr = Math.min(2, this.canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1);
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this.canvas.width = Math.round(SIZE * dpr);
      this.canvas.height = Math.round(SIZE * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const ctx = this.ctx;
    const c = SIZE / 2;
    const b = this.basis;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.beginPath();
    ctx.arc(c, c, RADIUS, 0, TAU);
    ctx.lineWidth = 1;
    ctx.strokeStyle = RING;
    ctx.stroke();

    for (const end of this.ends) {
      end.x = c + b[end.axis] * RADIUS * end.sign;
      end.y = c - b[3 + end.axis] * RADIUS * end.sign;
      end.depth = b[6 + end.axis] * end.sign;
    }
    this.ends.sort(byDepth);

    ctx.lineCap = 'round';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = this.font;
    for (const end of this.ends) this.drawEnd(end, c);
    ctx.globalAlpha = 1;
  }

  /** Axes fade with depth, so the triad reads as a ball, not a flat star. */
  private drawEnd(end: AxisEnd, c: number): void {
    const ctx = this.ctx;
    const color = COLORS[end.axis];
    const hovered = end.id === this.hover;
    const fade = 0.42 + (0.58 * (end.depth + 1)) / 2;
    ctx.globalAlpha = fade;

    if (end.sign > 0) {
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.lineTo(end.x, end.y);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = color;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(end.x, end.y, hovered ? DOT + 1.4 : end.sign > 0 ? DOT : DOT - 2.6, 0, TAU);
    if (end.sign > 0 || hovered) {
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(LABELS[end.axis], end.x, end.y + 0.5);
      return;
    }
    ctx.globalAlpha = fade * 0.2;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = fade;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  /** Swing the camera onto an axis: same target, same distance, short arc. */
  private snapTo(id: number): void {
    const axis = id >> 1;
    const dir: [number, number, number] = [0, 0, 0];
    dir[axis] = id % 2 === 0 ? 1 : -1;
    if (axis === 1) {
      dir[0] = NUDGE;
      dir[2] = NUDGE;
    }

    const pose = this.host.getPose();
    const target: [number, number, number] = [...pose.target];
    let vx = pose.position[0] - target[0];
    let vy = pose.position[1] - target[1];
    let vz = pose.position[2] - target[2];
    const dist = Math.hypot(vx, vy, vz) || 1;
    vx /= dist;
    vy /= dist;
    vz /= dist;

    const place = (x: number, y: number, z: number): void => {
      this.expected = {
        position: [target[0] + x * dist, target[1] + y * dist, target[2] + z * dist],
        target,
      };
      this.host.setPose(this.expected);
    };

    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    const angle = Math.acos(Math.max(-1, Math.min(1, vx * dir[0] + vy * dir[1] + vz * dir[2])));
    const still = this.canvas.ownerDocument.defaultView?.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    if (angle < 1e-3 || still) {
      place(dir[0], dir[1], dir[2]);
      return;
    }

    // Rotate the view vector about the axis common to both directions; a half
    // turn has no such axis, so any perpendicular does the flip.
    let kx = vy * dir[2] - vz * dir[1];
    let ky = vz * dir[0] - vx * dir[2];
    let kz = vx * dir[1] - vy * dir[0];
    let len = Math.hypot(kx, ky, kz);
    if (len < 1e-6) {
      kx = -vy;
      ky = vx;
      kz = 0;
      len = Math.hypot(kx, ky, kz);
      if (len < 1e-6) {
        kx = 1;
        ky = 0;
        kz = 0;
        len = 1;
      }
    }
    kx /= len;
    ky /= len;
    kz /= len;

    const start = performance.now();
    const step = (): void => {
      this.frame = 0;
      const now = this.host.getPose();
      const want = this.expected;
      if (
        want &&
        Math.hypot(
          now.position[0] - want.position[0],
          now.position[1] - want.position[1],
          now.position[2] - want.position[2],
        ) +
          Math.hypot(
            now.target[0] - want.target[0],
            now.target[1] - want.target[1],
            now.target[2] - want.target[2],
          ) >
          dist * 1e-3
      ) {
        return; // the user grabbed the camera mid flight
      }
      const p = Math.min(1, (performance.now() - start) / SNAP_MS);
      if (p >= 1) {
        place(dir[0], dir[1], dir[2]);
        return;
      }
      const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      const cos = Math.cos(angle * eased);
      const sin = Math.sin(angle * eased);
      const kv = (kx * vx + ky * vy + kz * vz) * (1 - cos);
      place(
        vx * cos + (ky * vz - kz * vy) * sin + kx * kv,
        vy * cos + (kz * vx - kx * vz) * sin + ky * kv,
        vz * cos + (kx * vy - ky * vx) * sin + kz * kv,
      );
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  dispose(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.canvas.remove();
  }
}
