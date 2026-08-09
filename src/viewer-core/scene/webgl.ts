import * as THREE from 'three';

/**
 * Context profiles are ordered from best image quality to widest GPU support.
 * Keeping the drawing buffer is deliberately off: it roughly doubles the
 * default framebuffer cost and screenshots already capture in the render task.
 */
export interface WebGlRendererProfile {
  readonly name: 'quality' | 'compatible' | 'low-power';
  readonly antialias: boolean;
  readonly preserveDrawingBuffer: false;
  readonly powerPreference: WebGLPowerPreference;
}

export interface WebGlRendererStartup {
  renderer: THREE.WebGLRenderer;
  profile: WebGlRendererProfile;
}

export type WebGlRendererFactory = (
  parameters: THREE.WebGLRendererParameters,
) => THREE.WebGLRenderer;

/** A stable error contract for the app shell and SDK consumers. */
export class WebGlUnavailableError extends Error {
  readonly code = 'WEBGL2_UNAVAILABLE' as const;

  constructor(cause?: unknown) {
    super(
      '3D graphics could not start because WebGL 2 is unavailable or all GPU contexts are in use. '
        + 'Enable browser hardware acceleration, close other 3D tabs, then reload IFCViewX.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'WebGlUnavailableError';
  }
}

export function webGlRendererProfiles(antialias = true): WebGlRendererProfile[] {
  return [
    {
      name: 'quality',
      antialias,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    },
    {
      name: 'compatible',
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: 'default',
    },
    {
      name: 'low-power',
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    },
  ];
}

/**
 * Ask the browser for WebGL explicitly before constructing Three's renderer.
 * This lets us retry a rejected discrete-GPU/MSAA request without leaving
 * half-constructed renderers and duplicate context listeners on the canvas.
 */
export function createWebGlRenderer(
  canvas: HTMLCanvasElement,
  antialias = true,
  factory: WebGlRendererFactory = (parameters) => new THREE.WebGLRenderer(parameters),
): WebGlRendererStartup {
  let lastError: unknown;

  for (const profile of webGlRendererProfiles(antialias)) {
    const attributes: WebGLContextAttributes = {
      alpha: false,
      antialias: profile.antialias,
      depth: true,
      failIfMajorPerformanceCaveat: false,
      powerPreference: profile.powerPreference,
      premultipliedAlpha: true,
      preserveDrawingBuffer: profile.preserveDrawingBuffer,
      stencil: true,
    };

    let context: WebGL2RenderingContext | null = null;
    try {
      context = canvas.getContext('webgl2', attributes);
    } catch (error) {
      lastError = error;
    }
    if (!context) continue;

    try {
      const renderer = factory({
        canvas,
        // Three r184 is WebGL 2-only, although its public type still names the
        // WebGL 1 base interface here.
        context: context as unknown as WebGLRenderingContext,
        ...attributes,
      });
      return { renderer, profile };
    } catch (error) {
      context.getExtension('WEBGL_lose_context')?.loseContext();
      throw new WebGlUnavailableError(error);
    }
  }

  throw new WebGlUnavailableError(lastError);
}
