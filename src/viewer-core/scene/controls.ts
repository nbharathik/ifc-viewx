// Camera interaction: OrbitControls wiring, fit-to-model / fit-to-element framing,
// GPU picking, key bindings (F = fit) and resize handling. Renders on change
// (no continuous RAF) so headless snapshots stay deterministic.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { SceneController, CameraPose } from './scene.js';

export interface PickResult {
  expressID: number;
  point: [number, number, number];
}

export interface ControlHandlers {
  /**
   * Single click on the viewport: pick result, or null when nothing was hit.
   * `additive` is a Ctrl/Cmd/Shift click, i.e. "add this to what I have".
   */
  onPick?: (pick: PickResult | null, additive: boolean) => void;
  /**
   * Pointer went down while a viewport tool is active. Returning true takes
   * the whole gesture: OrbitControls never sees it, and neither does the pick.
   * `moved` says the pointer has travelled far enough to count as a drag, so
   * the tool can treat a press-drag-release and two clicks the same way.
   */
  onToolDown?: (clientX: number, clientY: number) => boolean;
  onToolMove?: (clientX: number, clientY: number, moved: boolean) => void;
  onToolUp?: (clientX: number, clientY: number, moved: boolean) => void;
  /** Escape pressed. */
  onEscape?: () => void;
  /** H: hide selection. */
  onHide?: () => void;
  /** I: isolate selection. */
  onIsolate?: () => void;
  /** A: show all. */
  onShowAll?: () => void;
  /** Pointer went down on a viewport handle; true takes over the drag. */
  onHandleDown?: (ndcX: number, ndcY: number) => boolean;
  onHandleDrag?: (ndcX: number, ndcY: number) => void;
  onHandleUp?: () => void;
  /** Pointer moved with no button down; used for hover feedback. */
  onHover?: (ndcX: number, ndcY: number, clientX: number, clientY: number) => void;
}

export type ViewPreset = 'top' | 'front' | 'right' | 'iso';

const VIEW_DIRECTIONS: Record<ViewPreset, [number, number, number]> = {
  top: [0.001, 1, 0.001],
  front: [0, 0.001, 1],
  right: [1, 0.001, 0],
  iso: [1, 0.8, 1],
};

/** Compute a camera pose that frames a sphere (center, radius) along `dir`. */
function framePose(
  center: THREE.Vector3,
  radius: number,
  dir: THREE.Vector3,
  fovDeg: number,
  margin = 1.15,
  aspect = 1,
): CameraPose {
  const fov = (fovDeg * Math.PI) / 180;
  // A viewport narrower than it is tall has a smaller horizontal field, so
  // framing on the vertical one alone lets the model spill off the sides.
  const half = aspect < 1 ? 2 * Math.atan(Math.tan(fov / 2) * aspect) : fov;
  const distance = (Math.max(radius, 0.5) / Math.sin(half / 2)) * margin;
  const position = center.clone().add(dir.clone().normalize().multiplyScalar(distance));
  return {
    position: [position.x, position.y, position.z],
    target: [center.x, center.y, center.z],
  };
}

/** Clicks that travelled further than this since pointerdown are drags. */
const CLICK_MOVE_TOLERANCE_PX = 5;

export class ViewerControls {
  private readonly orbit: OrbitControls;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly doc: Document;
  private readonly keyHandler: (e: KeyboardEvent) => void;
  private readonly dblHandler: (e: MouseEvent) => void;
  private readonly clickHandler: (e: MouseEvent) => void;
  private readonly pointerDownHandler: (e: PointerEvent) => void;
  private readonly grabHandler: (e: PointerEvent) => void;
  private readonly hoverHandler: (e: PointerEvent) => void;
  private interacting = false;
  private adaptiveEnabled = true;
  private downX = 0;
  private downY = 0;
  /** A tool owns the left button; orbit is on the right one meanwhile. */
  private toolActive = false;
  /** Tears down an in-flight claim(), so dispose cannot leave listeners on. */
  private claimed: (() => void) | null = null;
  /** The press a tool claimed also owns the click its release produces. */
  private toolClaimed = false;

  constructor(
    private readonly scene: SceneController,
    private readonly container: HTMLElement,
    private readonly requestRender: () => void,
    private readonly handlers: ControlHandlers = {},
  ) {
    const dom = scene.renderer.domElement;
    this.doc = container.ownerDocument;

    this.orbit = new OrbitControls(scene.camera, dom);
    this.orbit.enableDamping = false; // deterministic: settle immediately
    this.orbit.addEventListener('start', () => {
      this.interacting = true;
    });
    this.orbit.addEventListener('change', () => {
      this.requestRender();
      this.adaptResolution();
    });
    this.orbit.addEventListener('end', () => {
      this.interacting = false;
      if (this.scene.getResolutionScale() !== 1) {
        this.scene.setResolutionScale(1);
        this.requestRender();
      }
    });

    this.pointerDownHandler = (e) => {
      this.downX = e.clientX;
      this.downY = e.clientY;
    };
    dom.addEventListener('pointerdown', this.pointerDownHandler);

    this.clickHandler = (e) => this.onClick(e);
    dom.addEventListener('click', this.clickHandler);

    this.dblHandler = (e) => this.onDoubleClick(e);
    dom.addEventListener('dblclick', this.dblHandler);

    // Capture on the container so a handle grab or an active tool is decided
    // before the canvas hands the event to OrbitControls.
    this.grabHandler = (e) => {
      // Widgets floating over the canvas (dock, gizmo) own their own clicks.
      this.toolClaimed = false;
      if (e.button !== 0 || e.target !== dom) return;
      const [x, y] = this.toNdc(e.clientX, e.clientY);
      if (this.handlers.onHandleDown?.(x, y)) {
        this.toolClaimed = true; // releasing a handle is not a selection either
        this.claim(
          e,
          (ev) => {
            const [mx, my] = this.toNdc(ev.clientX, ev.clientY);
            this.handlers.onHandleDrag?.(mx, my);
          },
          () => this.handlers.onHandleUp?.(),
        );
        return;
      }
      if (!this.handlers.onToolDown?.(e.clientX, e.clientY)) return;
      this.toolClaimed = true;
      let moved = false;
      const travelled = (ev: PointerEvent): boolean =>
        Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) > CLICK_MOVE_TOLERANCE_PX;
      this.claim(
        e,
        (ev) => {
          moved = moved || travelled(ev);
          this.handlers.onToolMove?.(ev.clientX, ev.clientY, moved);
        },
        (ev) => this.handlers.onToolUp?.(ev.clientX, ev.clientY, moved || travelled(ev)),
      );
    };
    container.addEventListener('pointerdown', this.grabHandler, true);

    this.hoverHandler = (e) => {
      if (!this.handlers.onHover || e.buttons !== 0) return;
      const [x, y] = this.toNdc(e.clientX, e.clientY);
      this.handlers.onHover(x, y, e.clientX, e.clientY);
    };
    dom.addEventListener('pointermove', this.hoverHandler);

    this.keyHandler = (e) => this.onKey(e);
    this.doc.addEventListener('keydown', this.keyHandler);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.onResize());
      this.resizeObserver.observe(container);
    }
  }

  /** Take a press away from OrbitControls and follow it to its release. */
  private claim(
    down: PointerEvent,
    move: (e: PointerEvent) => void,
    up: (e: PointerEvent) => void,
  ): void {
    down.stopPropagation();
    down.preventDefault();
    // One pointer owns the gesture: a second finger's release would otherwise
    // end the first one's drag, at the second one's coordinates.
    const id = down.pointerId;
    // pointercancel too: a touch-scroll takeover or palm rejection never fires
    // pointerup, and the stale listeners would replay on the next gesture.
    const onMove = (e: PointerEvent): void => {
      if (e.pointerId === id) move(e);
    };
    const onUp = (e: PointerEvent): void => {
      if (e.pointerId !== id) return;
      this.doc.removeEventListener('pointermove', onMove);
      this.doc.removeEventListener('pointerup', onUp);
      this.doc.removeEventListener('pointercancel', onUp);
      this.claimed = null;
      up(e);
    };
    this.claimed = () => onUp(new PointerEvent('pointercancel', { pointerId: id }));
    this.doc.addEventListener('pointermove', onMove);
    this.doc.addEventListener('pointerup', onUp);
    this.doc.addEventListener('pointercancel', onUp);
  }

  /**
   * Hand the left button to a viewport tool. Orbiting moves to the right
   * button and panning to the middle one, so the model can still be turned
   * around without putting the tool down.
   */
  setToolActive(on: boolean): void {
    if (on === this.toolActive) return;
    this.toolActive = on;
    this.orbit.mouseButtons = on
      ? { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  }

  /** Apply a pose, keeping OrbitControls' target in sync. */
  setPose(pose: CameraPose): void {
    this.scene.camera.position.set(...pose.position);
    this.orbit.target.set(...pose.target);
    this.scene.camera.updateProjectionMatrix();
    this.orbit.update();
    this.requestRender();
  }

  getPose(): CameraPose {
    const p = this.scene.camera.position;
    const t = this.orbit.target;
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
  }

  fitToModel(): CameraPose {
    return this.viewFrom('iso');
  }

  /** Frame the whole model from a preset direction. */
  viewFrom(view: ViewPreset): CameraPose {
    const b = this.scene.getBounds();
    const center = new THREE.Vector3(
      (b.min.x + b.max.x) / 2,
      (b.min.y + b.max.y) / 2,
      (b.min.z + b.max.z) / 2,
    );
    const radius =
      new THREE.Vector3(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z).length() * 0.5;
    const dir = new THREE.Vector3(...VIEW_DIRECTIONS[view]);
    const pose = framePose(center, radius, dir, this.scene.camera.fov, 1.15, this.scene.camera.aspect);
    this.applyNearFar(radius);
    this.setPose(pose);
    return pose;
  }

  /** Frame a single element by expressID; keeps the current viewing direction. */
  fitToElement(expressID: number): CameraPose | null {
    const bounds = this.scene.getElementBounds(expressID);
    if (!bounds) return null;
    const box = new THREE.Box3(
      new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
      new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
    );
    if (box.isEmpty()) return null;
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() * 0.5;
    const current = this.scene.camera.position.clone().sub(this.orbit.target);
    const dir = current.lengthSq() > 1e-6 ? current : new THREE.Vector3(1, 0.8, 1);
    const pose = framePose(center, radius, dir, this.scene.camera.fov, 1.3, this.scene.camera.aspect);
    // Sized from the model, not from the element: a far plane set by a door
    // radius clips the building the door is standing in.
    const scene = this.scene.getBounds();
    const span = new THREE.Vector3(
      scene.max.x - scene.min.x,
      scene.max.y - scene.min.y,
      scene.max.z - scene.min.z,
    ).length();
    this.applyNearFar(radius, Number.isFinite(span) ? span : radius);
    this.setPose(pose);
    return pose;
  }

  pickAt(clientX: number, clientY: number): PickResult | null {
    const rect = this.scene.renderer.domElement.getBoundingClientRect();
    return this.scene.pick(clientX - rect.left, clientY - rect.top);
  }

  /** Client coordinates to canvas CSS coordinates, which the scene picks in. */
  toCanvas(clientX: number, clientY: number): [number, number] {
    const rect = this.scene.renderer.domElement.getBoundingClientRect();
    return [clientX - rect.left, clientY - rect.top];
  }

  /** Client coordinates to normalized device coordinates in the canvas. */
  private toNdc(clientX: number, clientY: number): [number, number] {
    const rect = this.scene.renderer.domElement.getBoundingClientRect();
    return [
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    ];
  }

  /** `reach` is what must stay visible; `radius` only sets near-plane detail. */
  private applyNearFar(radius: number, reach = radius): void {
    const cam = this.scene.camera;
    cam.near = Math.max(radius / 1000, 0.001);
    cam.far = Math.max(Math.max(radius, reach) * 1000, 100);
    cam.updateProjectionMatrix();
  }

  /**
   * While dragging, trade resolution for frame rate when renders are slow.
   * Fast scenes never degrade; the end handler restores full resolution.
   */
  setAdaptiveResolution(on: boolean): void {
    this.adaptiveEnabled = on;
    if (!on && this.scene.getResolutionScale() !== 1) {
      this.scene.setResolutionScale(1);
      this.requestRender();
    }
  }

  private adaptResolution(): void {
    if (!this.interacting || !this.adaptiveEnabled) return;
    const lastMs = this.scene.getRenderTiming().lastMs;
    const scale = this.scene.getResolutionScale();
    if (lastMs > 45 && scale > 0.45) this.scene.setResolutionScale(0.45);
    else if (lastMs > 20 && scale > 0.6) this.scene.setResolutionScale(0.6);
  }

  /** True when the pointer travelled since pointerdown, i.e. an orbit/pan. */
  private wasDrag(e: MouseEvent): boolean {
    return (
      Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > CLICK_MOVE_TOLERANCE_PX
    );
  }

  private onClick(e: MouseEvent): void {
    // A press a tool took also owns the click its release produces.
    if (this.toolClaimed) {
      this.toolClaimed = false;
      return;
    }
    // Releasing an orbit/pan drag fires a click on the same element; only a
    // stationary click is a selection.
    if (this.wasDrag(e)) return;
    this.handlers.onPick?.(this.pickAt(e.clientX, e.clientY), e.ctrlKey || e.metaKey || e.shiftKey);
  }

  private onDoubleClick(e: MouseEvent): void {
    // A second point placed on the same spot is not a request to zoom to it.
    if (this.toolActive || this.wasDrag(e)) return;
    const pick = this.pickAt(e.clientX, e.clientY);
    if (pick) this.fitToElement(pick.expressID);
  }

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable)
    ) {
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'f':
      case 'F':
        // Shift+F frames the selection and belongs to the host.
        if (!e.shiftKey) this.fitToModel();
        break;
      case 'h':
      case 'H':
        this.handlers.onHide?.();
        break;
      case 'i':
      case 'I':
        this.handlers.onIsolate?.();
        break;
      case 'a':
      case 'A':
        this.handlers.onShowAll?.();
        break;
      case 'Escape':
        this.handlers.onEscape?.();
        break;
    }
  }

  private onResize(): void {
    const rect = this.container.getBoundingClientRect();
    this.scene.resize(rect.width, rect.height);
    this.requestRender();
  }

  dispose(): void {
    // A drag in flight holds document-level listeners that would outlive this.
    this.claimed?.();
    this.orbit.dispose();
    const dom = this.scene.renderer.domElement;
    this.container.removeEventListener('pointerdown', this.grabHandler, true);
    dom.removeEventListener('pointermove', this.hoverHandler);
    dom.removeEventListener('pointerdown', this.pointerDownHandler);
    dom.removeEventListener('click', this.clickHandler);
    dom.removeEventListener('dblclick', this.dblHandler);
    this.doc.removeEventListener('keydown', this.keyHandler);
    this.resizeObserver?.disconnect();
  }
}
