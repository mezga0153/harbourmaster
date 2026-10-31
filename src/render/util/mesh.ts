import { BoxGeometry, Mesh, MeshLambertMaterial, type BufferGeometry } from 'three';

// Geometry and materials every model shares. Never dispose these: they are
// not owned by any one object, and a disposed geometry would vanish from
// everything drawn with it.

/** A 1×1×1 box about the origin, scaled into every box drawn. */
export const unitBox = new BoxGeometry(1, 1, 1);

const materials = new Map<number, MeshLambertMaterial>();

/** The one flat-shaded material of each colour. */
export function mat(color: number): MeshLambertMaterial {
  let m = materials.get(color);
  if (!m) {
    m = new MeshLambertMaterial({ color, flatShading: true });
    materials.set(color, m);
  }
  return m;
}

/** The mesh, casting and taking shadows. */
export function shadowed<T extends Mesh>(mesh: T): T {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A shadowed mesh of `geo` in one colour. */
export function mesh(geo: BufferGeometry, color: number): Mesh {
  return shadowed(new Mesh(geo, mat(color)));
}
