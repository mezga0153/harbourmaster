import { Vector3, type Camera } from 'three';

// From a point in the world to where it falls on the screen.

const ndc = new Vector3();

export interface ScreenPoint {
  x: number;
  y: number;
  /** Behind the camera, or well outside the view: not worth drawing. */
  off: boolean;
}

/**
 * Where a point in the world falls on the canvas, in pixels from its
 * top-left corner, `rect` being the canvas's bounding rectangle. `world` is
 * left as it was.
 */
export function toCanvas(world: Vector3, camera: Camera, rect: DOMRect): ScreenPoint {
  const s = ndc.copy(world).project(camera);
  return {
    x: ((s.x + 1) / 2) * rect.width,
    y: ((1 - s.y) / 2) * rect.height,
    off: s.z > 1 || Math.abs(s.x) > 1.2 || Math.abs(s.y) > 1.2,
  };
}

/** As toCanvas, in client pixels (as a mouse event has them). */
export function toClient(world: Vector3, camera: Camera, rect: DOMRect): ScreenPoint {
  const p = toCanvas(world, camera, rect);
  p.x += rect.left;
  p.y += rect.top;
  return p;
}
