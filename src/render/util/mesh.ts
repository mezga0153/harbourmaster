import {
  AdditiveBlending,
  Box3,
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type BufferGeometry,
  type Object3D,
} from 'three';

// Geometry and materials every model shares. Never dispose these: they are
// not owned by any one object, and a disposed geometry would vanish from
// everything drawn with it.

/** A 1×1×1 box about the origin, scaled into every box drawn. */
export const unitBox = new BoxGeometry(1, 1, 1);

const materials = new Map<number, MeshLambertMaterial>();

/**
 * Colours that light up at night, windows and lamps, with the light they
 * give, how much, and how many times a second they flash, if they do.
 */
const glows = new Map<number, { light: number; strength: number; flash: number; always: number }>();
/** Light thrown on the ground at night, by colour and strength; see nightLight. */
const pools = new Map<string, { m: MeshBasicMaterial; strength: number }>();
/** How far into the night it is, 0 to 1, and the time in seconds, for flashing; see setNight. */
let night = 0;
let clock = 0;

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

/**
 * Everything drawn in `color` shines `light` at night, `strength` at its
 * brightest, flashing `flash` times a second if it is a beacon; and by
 * day too, `always` as bright, if it is to be seen then.
 */
export function glowAtNight(
  color: number,
  light: number,
  strength: number,
  flash = 0,
  always = 0,
): void {
  glows.set(color, { light, strength, flash, always });
  const m = materials.get(color);
  if (m) shine(color, m);
}

/**
 * A see-through glow laid on the ground, of light thrown there at night:
 * `strength` of `color` added to what is under it at its brightest, and
 * nothing at all by day.
 */
export function nightLight(color: number, strength: number): MeshBasicMaterial {
  const key = `${color}:${strength}`;
  let p = pools.get(key);
  if (!p) {
    const m = new MeshBasicMaterial({
      color,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    p = { m, strength };
    pools.set(key, p);
    pool(p);
  }
  return p.m;
}

/**
 * Windows and lamps lit as far as `n`, 0 by day to 1 at night, and the
 * light they throw; `time` in seconds, for the beacons to flash by.
 */
export function setNight(n: number, time = 0): void {
  const flashing = n > 0 && [...glows.values()].some((g) => g.flash > 0);
  if (n === night && !flashing) return;
  night = n;
  clock = time;
  for (const color of glows.keys()) {
    const m = materials.get(color);
    if (m) shine(color, m);
  }
  for (const p of pools.values()) pool(p);
}

function shine(color: number, m: MeshLambertMaterial): void {
  const g = glows.get(color);
  if (!g) return;
  m.emissive.set(g.light);
  const on = g.flash > 0 && (clock * g.flash) % 1 >= 0.5 ? 0.12 : 1;
  m.emissiveIntensity = Math.max(g.always, g.strength * night) * on;
}

function pool(p: { m: MeshBasicMaterial; strength: number }): void {
  p.m.opacity = p.strength * night;
  p.m.visible = night > 0.02;
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

const part = new Box3();

/**
 * What `o` takes up, as Box3.setFromObject has it, but leaving out the
 * light it throws on the ground at night (see lights.ts), which is not
 * part of it.
 */
export function solidBounds(o: Object3D, into = new Box3()): Box3 {
  o.updateWorldMatrix(true, true);
  o.traverse((c) => {
    if (!(c instanceof Mesh) || c.userData.thrown) return;
    const g = c.geometry as BufferGeometry;
    if (!g.boundingBox) g.computeBoundingBox();
    into.union(part.copy(g.boundingBox!).applyMatrix4(c.matrixWorld));
  });
  return into;
}
