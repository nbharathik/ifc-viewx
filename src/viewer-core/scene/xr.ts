// WebXR: the same model, seen from inside it.
//
// A desktop viewer needs a second application to do this at all. three
// already ships the WebXR path, so what is actually needed is the session
// lifecycle, an animation loop the headset drives, and putting the user
// somewhere sensible rather than at the scene origin, which on a
// georeferenced model can be a kilometre from the building.
import type * as THREE from 'three';

export type XrMode = 'immersive-vr' | 'immersive-ar';

interface XrHost {
  renderer: THREE.WebGLRenderer;
  /** Draw one frame. The headset drives the rate, not the app. */
  draw(): void;
  /** Where the user should stand: usually the orbit target on the floor. */
  standAt(): [number, number, number];
  /** Gizmos and the plan inset make no sense inside a headset. */
  setPresenting(on: boolean): void;
}

/** navigator.xr is typed by the DOM lib where it exists and absent where it does not. */
const xrSystem = (): XRSystem | undefined =>
  typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { xr?: XRSystem }).xr;

export class XrController {
  private session: XRSession | null = null;
  private mode: XrMode | null = null;
  private endListener: { session: XRSession; listener: () => void } | null = null;
  private readonly closing = new WeakMap<XRSession, Promise<void>>();
  private disposed = false;
  private readonly listeners = new Set<(mode: XrMode | null) => void>();

  constructor(private readonly host: XrHost) {}

  static available(): boolean {
    return xrSystem() !== undefined;
  }

  async supported(mode: XrMode): Promise<boolean> {
    if (!XrController.available()) return false;
    try {
      return await xrSystem()!.isSessionSupported(mode);
    } catch {
      return false;
    }
  }

  isPresenting(): boolean {
    return this.session !== null;
  }

  current(): XrMode | null {
    return this.mode;
  }

  onChange(listener: (mode: XrMode | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Start a session. Must be called from a user gesture: every browser
   * refuses an immersive session raised any other way.
   */
  async start(mode: XrMode): Promise<void> {
    if (this.disposed) throw new Error('This WebXR controller has been disposed');
    if (this.session) await this.end();
    if (this.disposed) throw new Error('This WebXR controller has been disposed');
    if (!XrController.available()) throw new Error('This browser has no WebXR support');
    const options =
      mode === 'immersive-ar'
        ? { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'dom-overlay'] }
        : { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] };
    const session = await xrSystem()!.requestSession(mode, options);
    if (this.disposed) {
      await this.closeSession(session);
      throw new Error('This WebXR controller has been disposed');
    }
    this.session = session;
    const renderer = this.host.renderer;
    const onEnd = (): void => this.cleanup(session);
    this.endListener = { session, listener: onEnd };
    session.addEventListener('end', onEnd);
    try {
      renderer.xr.enabled = true;
      // local-floor puts the origin on the floor the headset found, which is
      // what makes a 1.7 m eye height land on the model's own storey slab.
      renderer.xr.setReferenceSpaceType('local-floor');
      await renderer.xr.setSession(session as unknown as XRSession & { renderState: XRRenderState });
      if (this.session !== session || this.disposed) {
        throw new Error('The WebXR session ended before startup completed');
      }
      this.placeUser();
      this.host.setPresenting(true);
      renderer.setAnimationLoop(() => this.host.draw());
      if (this.session !== session || this.disposed) {
        throw new Error('The WebXR session ended before startup completed');
      }
      this.mode = mode;
    } catch (error) {
      this.cleanup(session);
      await this.closeSession(session);
      throw error;
    }
    this.emit();
  }

  async end(): Promise<void> {
    const session = this.session;
    if (!session) return;
    // Tear down synchronously. The browser's end event may arrive before or
    // after end() settles, but it no longer owns any live viewer state.
    this.cleanup(session);
    await this.closeSession(session);
  }

  /** Stop presentation and ask the browser to close, without awaiting dispose. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const session = this.session;
    if (session) {
      this.cleanup(session);
      void this.closeSession(session);
    }
    this.listeners.clear();
  }

  private cleanup(session: XRSession): void {
    // A late end event from an old session must not tear down its replacement.
    if (this.session !== session) return;
    const binding = this.endListener;
    if (binding?.session === session) {
      session.removeEventListener('end', binding.listener);
      this.endListener = null;
    }
    const changed = this.mode !== null;
    this.session = null;
    this.mode = null;
    const renderer = this.host.renderer;
    renderer.setAnimationLoop(null);
    renderer.xr.enabled = false;
    this.host.setPresenting(false);
    if (changed) this.emit();
  }

  /** One browser close request per session, shared by end/failure/disposal. */
  private closeSession(session: XRSession): Promise<void> {
    const existing = this.closing.get(session);
    if (existing) return existing;
    let settle!: () => void;
    const closing = new Promise<void>((resolve) => { settle = resolve; });
    this.closing.set(session, closing);
    try {
      void session.end().then(settle, settle);
    } catch {
      settle();
    }
    return closing;
  }

  /**
   * Move the reference space so the user stands where the camera was looking.
   * The offset describes the new origin in the old space, so standing at `p`
   * means offsetting by `-p`.
   */
  private placeUser(): void {
    const renderer = this.host.renderer;
    const base = renderer.xr.getReferenceSpace();
    if (!base || typeof base.getOffsetReferenceSpace !== 'function') return;
    const [x, y, z] = this.host.standAt();
    try {
      const offset = base.getOffsetReferenceSpace(
        new XRRigidTransform({ x: -x, y: -y, z: -z }, { x: 0, y: 0, z: 0, w: 1 }),
      );
      renderer.xr.setReferenceSpace(offset);
    } catch {
      // An unmovable reference space is not fatal: the user starts at the
      // scene origin and walks, which is still a session.
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.mode);
  }
}
