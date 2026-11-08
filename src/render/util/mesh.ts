import { BoxGeometry, Mesh, MeshLambertMaterial, type BufferGeometry } from 'three';

// Geometry and materials every model shares. Never dispose these: they are
// not owned by any one object, and a disposed geometry would vanish from
// everything drawn with it.

/** A 1×1×1 box about the origin, scaled into every box drawn. */
export const unitBox = new BoxGeometry(1, 1, 1);

const materials = new Map<number, MeshLambertMaterial>();

/** Colours that light up at night, windows and lamps, with the light they give and how much. */
const glows = new Map<number, { light: number; strength: number }>();
/** How far into the night it is, 0 to 1; see setNight. */
let night = 0;

/** The one flat-shaded material of each colour. */
export function mat(color: number): MeshLambertMaterial {
  let m = materials.get(color);
  if (!m) {
    m = new MeshLambertMaterial({ color, flatShading: true });
    materials.set(color, m);
    shine(color, m);
  }
  return m;
}

/** Everything drawn in `color` shines `light` at night, `strength` at its brightest. */
export function glowAtNight(color: number, light: number, strength: number): void {
  glows.set(color, { light, strength });
  const m = materials.get(color);
  if (m) shine(color, m);
}

/** Windows and lamps lit as far as `n`, 0 by day to 1 at night. */
export function setNight(n: number): void {
  if (n === night) return;
  night = n;
  for (const color of glows.keys()) {
    const m = materials.get(color);
    if (m) shine(color, m);
  }
}

function shine(color: number, m: MeshLambertMaterial): void {
  const g = glows.get(color);
  if (!g) return;
  m.emissive.set(g.light);
  m.emissiveIntensity = g.strength * night;
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
