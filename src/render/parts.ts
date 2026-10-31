import { CylinderGeometry, Mesh, Vector3, type BufferGeometry, type Object3D } from 'three';
import { mat, shadowed, unitBox } from './util/mesh';

// Shared geometry and materials for the procedural models. Never dispose these.

export { mat };

const cylinders = new Map<string, BufferGeometry>();

/** Box with its base at `y`. */
export function box(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0): Mesh {
  const mesh = new Mesh(unitBox, mat(color));
  mesh.scale.set(w, h, d);
  mesh.position.set(x, y + h / 2, z);
  return shadowed(mesh);
}

/** Upright cylinder with its base at `y`. */
export function cyl(r: number, h: number, color: number, x = 0, y = 0, z = 0, seg = 6): Mesh {
  const key = `${seg}`;
  let g = cylinders.get(key);
  if (!g) {
    g = new CylinderGeometry(1, 1, 1, seg);
    cylinders.set(key, g);
  }
  const mesh = new Mesh(g, mat(color));
  mesh.scale.set(r, h, r);
  mesh.position.set(x, y + h / 2, z);
  return shadowed(mesh);
}

/** A thin bar from `a` to `b`, for stays and bracing. */
export function strut(
  a: [number, number, number],
  b: [number, number, number],
  thick: number,
  color: number,
): Object3D {
  const from = new Vector3(...a);
  const to = new Vector3(...b);
  const bar = box(thick, thick, from.distanceTo(to), color);
  bar.position.copy(from).add(to).multiplyScalar(0.5);
  bar.lookAt(to);
  return bar;
}
