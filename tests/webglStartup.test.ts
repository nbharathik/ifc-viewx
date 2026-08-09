import { describe, expect, it, vi } from 'vitest';
import type * as THREE from 'three';

import {
  createWebGlRenderer,
  WebGlUnavailableError,
  webGlRendererProfiles,
} from '../src/viewer-core/scene/webgl.js';

describe('WebGL renderer startup', () => {
  it('uses a non-preserved drawing buffer for every memory-conscious profile', () => {
    const profiles = webGlRendererProfiles(true);
    expect(profiles.map((profile) => profile.name)).toEqual(['quality', 'compatible', 'low-power']);
    expect(profiles[0]).toMatchObject({ antialias: true, powerPreference: 'high-performance' });
    expect(profiles.every((profile) => profile.preserveDrawingBuffer === false)).toBe(true);
  });

  it('falls back from a rejected quality context to a compatible context', () => {
    const context = { getExtension: vi.fn(() => null) } as unknown as WebGL2RenderingContext;
    const getContext = vi.fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(context);
    const canvas = { getContext } as unknown as HTMLCanvasElement;
    const renderer = {} as THREE.WebGLRenderer;
    const factory = vi.fn(() => renderer);

    const startup = createWebGlRenderer(canvas, true, factory);

    expect(startup.renderer).toBe(renderer);
    expect(startup.profile.name).toBe('compatible');
    expect(startup.profile.antialias).toBe(false);
    expect(getContext).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ canvas, context, antialias: false }));
  });

  it('returns an actionable typed error after every WebGL 2 profile is rejected', () => {
    const canvas = { getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement;

    expect(() => createWebGlRenderer(canvas)).toThrow(WebGlUnavailableError);
    expect(() => createWebGlRenderer(canvas)).toThrow(/hardware acceleration/i);
    expect(canvas.getContext).toHaveBeenCalledTimes(6);
  });
});
