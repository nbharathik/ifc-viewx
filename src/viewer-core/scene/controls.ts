// Camera interaction: OrbitControls wiring, fit-to-model / fit-to-element framing,
// GPU picking, key bindings (F = fit) and resize handling. Renders on change
// (no continuous RAF) so headless snapshots stay deterministic.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { SceneController, CameraPose, SnapKind, ProjectionMode } from './scene.js';

export interface PickResult {
  expressID: number;
  point: [number, number, number];
  /** Present when a precision-pick guide supplied the point. */
  kind?: SnapKind;
}

export interface ControlHandlers {
  /**
   * Single click on the viewport: pick result, or null when nothing was hit.
   * `additive` is a Ctrl/Cmd/Shift click, i.e. "add this to what I have".
   */
  onPick?: (pick: PickResult | null, additive: boolean, clientX: number, clientY: number) => void;
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
  /** Tool-specific unmodified key. True means the tool consumed it. */
  onToolKey?: (key: string) => boolean;
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
  onCameraChange?: () => void;
}

export type ViewPreset = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso';

const VIEW_DIRECTIONS: Record<ViewPreset, [number, number, number]> = {
  top: [0.001, 1, 0.001],
  bottom: [0.001, -1, 0.001],
  front: [0, 0.001, 1],
  back: [0, 0.001, -1],
  right: [1, 0.001, 0],
  left: [-1, 0.001, 0],
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
/** Wheel zoom limits while flying: telephoto to a wide first-person view. */
const FLY_FOV_MIN = 20;
const FLY_FOV_MAX = 90;
const UI_KEYBOARD_TARGET = [
  'input',
  'textarea',
  'select',
  'button',
  'a[href]',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tree"]',
  '[tabindex]:not([tabindex="-1"]):not(canvas)',
].join(',');

const _worldUp = new THREE.Vector3(0, 1, 0);
const _flyForward = new THREE.Vector3();
const _flyRight = new THREE.Vector3();

export class ViewerControls {
  private readonly orbit: OrbitControls;
  private readonly resizeObserver: ResizeObserver | null = null;
  private readonly viewportHandler: () => void;
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
      this.handlers.onCameraChange?.();
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
      if (this.fly) return;
      if (e.button !== 0 || e.target !== dom) return;
      // Layout may have moved since the last hover; a gesture starts fresh.
      this.invalidateRect();
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
      if (this.fly) return;
      if (!this.handlers.onHover || e.buttons !== 0) return;
      const [x, y] = this.toNdc(e.clientX, e.clientY);
      this.handlers.onHover(x, y, e.clientX, e.clientY);
    };
    dom.addEventListener('pointermove', this.hoverHandler);

    this.keyHandler = (e) => this.onKey(e);
    this.doc.addEventListener('keydown', this.keyHandler);

    // A ResizeObserver catches the canvas changing size, but not the page
    // scrolling or a sibling panel shifting it sideways, and both move the
    // rect without resizing it.
    this.viewportHandler = () => this.invalidateRect();
    window.addEventListener('resize', this.viewportHandler);
    window.addEventListener('scroll', this.viewportHandler, true);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.onResize());
      this.resizeObserver.observe(container);
    }
  }

  // -- fly mode ---------------------------------------------------------------
  /** Live state while first-person flight is on; null otherwise. */
  private fly: {
    keys: Set<string>;
    speed: number;
    last: number;
    raf: number;
    dirty: boolean;
    targetDistance: number;
    euler: THREE.Euler;
    /** Field of view on entry, so leaving flight restores the framing. */
    fov: number;
    /** Whether the plan inset was already showing before flight opened it. */
    plan: boolean;
    onKeyDown: (e: KeyboardEvent) => void;
    onKeyUp: (e: KeyboardEvent) => void;
    onMouse: (e: MouseEvent) => void;
    onWheel: (e: WheelEvent) => void;
    onLockChange: () => void;
  } | null = null;
  private flyListeners = new Set<(on: boolean) => void>();

  /** Metres per second the flight is moving at, or null when not flying. */
  getFlySpeed(): number | null {
    return this.fly ? this.fly.speed * (this.fly.keys.has('shift') ? 4 : 1) : null;
  }

  onFlyChange(listener: (on: boolean) => void): () => void {
    this.flyListeners.add(listener);
    return () => this.flyListeners.delete(listener);
  }

  isFlying(): boolean {
    return this.fly !== null;
  }

  /** Keys the flight loop owns while it is on. */
  private static readonly FLY_KEYS = new Set([
    'w', 'a', 's', 'd', 'q', 'e', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  ]);

  startFly(): void {
    if (this.fly) return;
    // Flight is a perspective experience; parallel projection cannot dolly.
    if (this.getProjection() === 'orthographic') this.setProjection('perspective');
    const cam = this.scene.camera;
    const dom = this.scene.renderer.domElement;
    const bounds = this.scene.getBounds();
    const span = Number.isFinite(bounds.min.x)
      ? Math.hypot(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z)
      : 40;
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    euler.setFromQuaternion(cam.quaternion);
    euler.z = 0;

    const fly: NonNullable<ViewerControls['fly']> = {
      keys: new Set<string>(),
      speed: Math.min(60, Math.max(1, span / 8)),
      last: performance.now(),
      raf: 0,
      dirty: false,
      targetDistance: Math.max(cam.position.distanceTo(this.orbit.target), 1),
      euler,
      fov: this.scene.getFieldOfView(),
      plan: this.scene.isPlanView(),
      onKeyDown: (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        // UI controls and modal surfaces own their keys even during flight.
        if (this.uiOwnsKeyboard(e)) return;
        const key = e.key.toLowerCase();
        if (key === 'shift') fly.keys.add('shift');
        if (!ViewerControls.FLY_KEYS.has(key)) return;
        fly.keys.add(key);
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      onKeyUp: (e) => {
        const key = e.key.toLowerCase();
        fly.keys.delete(key === 'shift' ? 'shift' : key);
      },
      onMouse: (e) => {
        if (this.doc.pointerLockElement !== dom) return;
        fly.euler.y -= e.movementX * 0.0024;
        fly.euler.x -= e.movementY * 0.0024;
        const limit = Math.PI / 2 - 0.02;
        fly.euler.x = Math.min(limit, Math.max(-limit, fly.euler.x));
        this.scene.camera.quaternion.setFromEuler(fly.euler);
        fly.dirty = true;
      },
      onWheel: (e) => {
        e.preventDefault();
        // The wheel zooms the view, which is what a wheel does everywhere
        // else in the app; Shift keeps the flight-speed control it replaced.
        if (e.shiftKey) {
          fly.speed = Math.min(500, Math.max(0.2, fly.speed * Math.pow(1.15, -e.deltaY / 100)));
          return;
        }
        const zoom = this.scene.getFieldOfView() * Math.pow(1.1, e.deltaY / 100);
        this.scene.setFieldOfView(Math.min(FLY_FOV_MAX, Math.max(FLY_FOV_MIN, zoom)));
        fly.dirty = true;
      },
      onLockChange: () => {
        if (this.doc.pointerLockElement !== dom) this.stopFly();
      },
    };
    this.fly = fly;
    this.orbit.enabled = false;
    this.interacting = true;
    // The plan doubles as the locator while flying, so it comes up with the
    // flight and goes away again unless it was already open. Rendering is on
    // change, so the inset needs a frame asked for or it waits for the first
    // keypress to appear.
    if (!fly.plan) {
      this.scene.setPlanView(true);
      this.requestRender();
    }
    this.doc.addEventListener('keydown', fly.onKeyDown, true);
    this.doc.addEventListener('keyup', fly.onKeyUp, true);
    this.doc.addEventListener('mousemove', fly.onMouse);
    dom.addEventListener('wheel', fly.onWheel, { passive: false });
    this.doc.addEventListener('pointerlockchange', fly.onLockChange);
    // Without lock the keys still fly; only mouse look needs the capture.
    // The request can reject (hidden documents, iframes without permission);
    // flight carries on without mouse look, so the rejection is not an error.
    try {
      void (dom.requestPointerLock?.() as unknown as Promise<void> | undefined)?.catch?.(() => undefined);
    } catch {
      // Older engines throw synchronously instead of rejecting.
    }

    const step = (now: number): void => {
      const f = this.fly;
      if (!f) return;
      const dt = Math.min((now - f.last) / 1000, 0.1);
      f.last = now;
      const cam2 = this.scene.camera;
      const boost = f.keys.has('shift') ? 4 : 1;
      const move = f.speed * boost * dt;
      let changed = f.dirty;
      f.dirty = false;
      if (move > 0 && f.keys.size > 0) {
        const forward = cam2.getWorldDirection(_flyForward);
        const right = _flyRight.crossVectors(forward, _worldUp).normalize();
        const has = (k: string, alias: string): boolean => f.keys.has(k) || f.keys.has(alias);
        if (has('w', 'arrowup')) { cam2.position.addScaledVector(forward, move); changed = true; }
        if (has('s', 'arrowdown')) { cam2.position.addScaledVector(forward, -move); changed = true; }
        if (has('d', 'arrowright')) { cam2.position.addScaledVector(right, move); changed = true; }
        if (has('a', 'arrowleft')) { cam2.position.addScaledVector(right, -move); changed = true; }
        if (f.keys.has('e') || f.keys.has(' ')) { cam2.position.y += move; changed = true; }
        if (f.keys.has('q')) { cam2.position.y -= move; changed = true; }
      }
      if (changed) {
        this.handlers.onCameraChange?.();
        this.requestRender();
        this.adaptResolution();
      }
      f.raf = requestAnimationFrame(step);
    };
    fly.raf = requestAnimationFrame(step);
    for (const listener of this.flyListeners) listener(true);
  }

  stopFly(): void {
    const fly = this.fly;
    if (!fly) return;
    this.fly = null;
    cancelAnimationFrame(fly.raf);
    const dom = this.scene.renderer.domElement;
    this.doc.removeEventListener('keydown', fly.onKeyDown, true);
    this.doc.removeEventListener('keyup', fly.onKeyUp, true);
    this.doc.removeEventListener('mousemove', fly.onMouse);
    dom.removeEventListener('wheel', fly.onWheel);
    this.doc.removeEventListener('pointerlockchange', fly.onLockChange);
    if (this.doc.pointerLockElement === dom) this.doc.exitPointerLock?.();
    // Orbit resumes around a target ahead of where the flight ended, at the
    // framing it had before, and without the locator if flight opened it.
    const cam = this.scene.camera;
    this.scene.setFieldOfView(fly.fov);
    if (!fly.plan) this.scene.setPlanView(false);
    const forward = cam.getWorldDirection(_flyForward);
    this.orbit.target.copy(cam.position).addScaledVector(forward, fly.targetDistance);
    this.orbit.enabled = true;
    this.interacting = false;
    if (this.scene.getResolutionScale() !== 1) this.scene.setResolutionScale(1);
    this.orbit.update();
    this.requestRender();
    for (const listener of this.flyListeners) listener(false);
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
    // Poses are computed with perspective framing math; in ortho the frustum
    // height stands in for the dolly distance, so it follows the same pose.
    this.scene.matchOrthoToDistance(
      Math.hypot(
        pose.position[0] - pose.target[0],
        pose.position[1] - pose.target[1],
        pose.position[2] - pose.target[2],
      ),
    );
    this.scene.camera.updateProjectionMatrix();
    this.orbit.update();
    this.requestRender();
  }

  /** Switch between perspective and orthographic without a visual jump. */
  setProjection(mode: ProjectionMode): void {
    const t = this.orbit.target;
    this.scene.setProjectionMode(mode, [t.x, t.y, t.z]);
    this.orbit.object = this.scene.camera;
    this.orbit.update();
    this.requestRender();
  }

  getProjection(): ProjectionMode {
    return this.scene.getProjectionMode();
  }

  /** Orbit the camera about the world up axis by the given angle. */
  rotateView(degrees: number): void {
    const target = this.orbit.target;
    const offset = this.scene.camera.position.clone().sub(target);
    offset.applyAxisAngle(_worldUp, (degrees * Math.PI) / 180);
    this.scene.camera.position.copy(target).add(offset);
    this.orbit.update();
    this.requestRender();
  }

  /**
   * Look at the current target from along `direction`, keeping the distance.
   * The perpendicular-view command feeds a picked face normal through here.
   */
  lookAlong(direction: [number, number, number]): void {
    const dir = new THREE.Vector3(...direction);
    if (dir.lengthSq() < 1e-12) return;
    dir.normalize();
    // Straight up or down sits on the orbit pole; nudge off it.
    if (Math.abs(dir.x) < 1e-4 && Math.abs(dir.z) < 1e-4) dir.x = 1e-3;
    const target = this.orbit.target;
    const distance = Math.max(this.scene.camera.position.distanceTo(target), 0.5);
    this.scene.camera.position.copy(target).addScaledVector(dir.normalize(), distance);
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
    const frame = this.scene.getFrameParams();
    const pose = framePose(center, radius, dir, frame.fov, 1.15, frame.aspect);
    this.applyNearFar(radius);
    this.setPose(pose);
    return pose;
  }

  /**
   * Frame a point in space at a given working radius, keeping the current
   * viewing direction. What a clash result zooms to: the collision itself,
   * not the box around whichever element happens to be listed first.
   */
  fitToPoint(point: [number, number, number], radius: number): CameraPose {
    const centre = new THREE.Vector3(...point);
    const current = this.scene.camera.position.clone().sub(this.orbit.target);
    const dir = current.lengthSq() > 1e-6 ? current : new THREE.Vector3(1, 0.8, 1);
    const scene = this.scene.getBounds();
    const span = new THREE.Vector3(
      scene.max.x - scene.min.x,
      scene.max.y - scene.min.y,
      scene.max.z - scene.min.z,
    ).length();
    const safe = Math.max(radius, 0.25);
    const frame = this.scene.getFrameParams();
    const pose = framePose(centre, safe, dir, frame.fov, 1.6, frame.aspect);
    this.applyNearFar(safe, Number.isFinite(span) && span > 0 ? span : safe);
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
    const frame = this.scene.getFrameParams();
    const pose = framePose(center, radius, dir, frame.fov, 1.3, frame.aspect);
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

  /**
   * The canvas rectangle, cached.
   *
   * Every pointer coordinate conversion needs it, and hover runs one per mouse
   * move. `getBoundingClientRect` forces a synchronous layout, and the hover
   * handler writes a class immediately before it, so reading it per move was a
   * full style and layout recalc on every move: measured at 1.65 ms per move
   * on a 293-element model, which is most of a frame spent on nothing.
   *
   * Invalidated by the events that can actually move the canvas, plus at the
   * start of every gesture, so a drag never works from a stale rect.
   */
  private rect: DOMRect | null = null;

  private canvasRect(): DOMRect {
    if (!this.rect) this.rect = this.scene.renderer.domElement.getBoundingClientRect();
    return this.rect;
  }

  /** Call when anything could have moved or resized the canvas. */
  invalidateRect(): void {
    this.rect = null;
  }

  /**
   * What is under a client point, from whichever view it landed in.
   *
   * The plan inset sits over the bottom-left of the same canvas, so a click
   * there would otherwise be answered by the 3D camera and select whatever
   * happens to be behind the inset. Routing it to the plan camera is what
   * makes the two views one navigable thing rather than a picture in a corner.
   */
  pickAt(clientX: number, clientY: number): PickResult | null {
    const rect = this.canvasRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const inset = this.scene.getPlanRect();
    if (inset) {
      // The inset rect is measured from the bottom-left, as GL viewports are.
      const left = inset.x;
      const top = rect.height - inset.y - inset.size;
      if (x >= left && x <= left + inset.size && y >= top && y <= top + inset.size) {
        return this.scene.pickInPlan(x - left, y - top);
      }
    }
    return this.scene.pick(x, y);
  }

  /** Client coordinates to canvas CSS coordinates, which the scene picks in. */
  toCanvas(clientX: number, clientY: number): [number, number] {
    const rect = this.canvasRect();
    return [clientX - rect.left, clientY - rect.top];
  }

  /** Client coordinates to normalized device coordinates in the canvas. */
  private toNdc(clientX: number, clientY: number): [number, number] {
    const rect = this.canvasRect();
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
    if (this.fly) return;
    // A press a tool took also owns the click its release produces.
    if (this.toolClaimed) {
      this.toolClaimed = false;
      return;
    }
    // Releasing an orbit/pan drag fires a click on the same element; only a
    // stationary click is a selection.
    if (this.wasDrag(e)) return;
    // Alt-click in the plan inset teleports: slide the camera horizontally so
    // the clicked ground point becomes the orbit target, keeping height and
    // heading. Alt is free; the other modifiers mean additive selection.
    if (e.altKey) {
      const rect = this.canvasRect();
      const inset = this.scene.getPlanRect();
      if (inset) {
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const top = rect.height - inset.y - inset.size;
        if (x >= inset.x && x <= inset.x + inset.size && y >= top && y <= top + inset.size) {
          const ground = this.scene.planPointAt(x - inset.x, y - top);
          if (ground) {
            const pose = this.getPose();
            const dx = ground[0] - pose.target[0];
            const dz = ground[1] - pose.target[2];
            this.setPose({
              position: [pose.position[0] + dx, pose.position[1], pose.position[2] + dz],
              target: [ground[0], pose.target[1], ground[1]],
            });
            return;
          }
        }
      }
    }
    this.handlers.onPick?.(
      this.pickAt(e.clientX, e.clientY),
      e.ctrlKey || e.metaKey || e.shiftKey,
      e.clientX,
      e.clientY,
    );
  }

  private onDoubleClick(e: MouseEvent): void {
    // A second point placed on the same spot is not a request to zoom to it.
    if (this.fly || this.toolActive || this.wasDrag(e)) return;
    const pick = this.pickAt(e.clientX, e.clientY);
    if (pick) this.fitToElement(pick.expressID);
  }

  private onKey(e: KeyboardEvent): void {
    if (this.uiOwnsKeyboard(e)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.fly) {
      // Movement keys are consumed by the flight's own capture listener; the
      // only chrome that stays live in flight is the way out.
      if (e.key === 'Escape') this.stopFly();
      return;
    }
    if (this.toolActive && this.handlers.onToolKey?.(e.key.toLowerCase())) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
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

  /** App controls and top-layer dialogs take precedence over viewport keys. */
  private uiOwnsKeyboard(e: KeyboardEvent): boolean {
    if (this.doc.querySelector('dialog[open]')) return true;
    const customModal = [...this.doc.querySelectorAll('[aria-modal="true"]')].some(
      (modal) => !modal.closest('.hidden, [hidden], [aria-hidden="true"]'),
    );
    if (customModal) return true;
    const target = e.target as Element | null;
    return Boolean(target?.closest?.(UI_KEYBOARD_TARGET));
  }

  private onResize(): void {
    this.invalidateRect();
    const rect = this.container.getBoundingClientRect();
    this.scene.resize(rect.width, rect.height);
    this.requestRender();
  }

  dispose(): void {
    this.stopFly();
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
    window.removeEventListener('resize', this.viewportHandler);
    window.removeEventListener('scroll', this.viewportHandler, true);
  }
}
