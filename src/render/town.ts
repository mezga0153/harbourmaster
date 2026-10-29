import {
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Build } from '../sim/types';
import { C } from './palette';
import { box, cyl, mat } from './parts';

// The town's buildings, from a fisher's cottage to a tower block. Each is
// drawn on a 1×1 tile facing +z, onto its street, and turned into place by
// Structures. `v` in [0, 1) picks the paint and the details.

const WALLS = [0xf4efe4, 0xf1e2c0, 0xd9e6ee, 0xf2d7c9, 0xe9e4a8, 0xcfe0c8];
const ROOFS = [0xb5533c, 0x5d6670, 0x8c3b30, 0x6b4f3f];
const BRICK = [0xb8674a, 0xc98f5e, 0xa9a39a, 0xd4c3a3];
const GLASS = [0x5f7f99, 0x6c8ea6, 0x4f6d84];
const AWNINGS = [0xd6453d, 0x2f6fd0, 0x3fa34d, 0xf2c230];
const DOOR = 0x5a3d2b;
const PAVING = 0xc9c4ba;
const KERB = 0xb0aaa0;

/** A gable roof: a prism one unit long (x), deep (z) and high, its base at y=0. */
const gableGeo = new CylinderGeometry(1, 1, 1, 3);
gableGeo.rotateZ(Math.PI / 2);
gableGeo.rotateX(-Math.PI / 2);
gableGeo.translate(0, 0.5, 0);
gableGeo.scale(1, 1 / 1.5, 1 / Math.sqrt(3));
const spireGeo = new ConeGeometry(1, 1, 4);
spireGeo.translate(0, 0.5, 0);
const treeGeo = new ConeGeometry(1, 1, 6);
treeGeo.translate(0, 0.5, 0);
const canopyGeo = new ConeGeometry(1, 1, 8);
canopyGeo.translate(0, 0.5, 0);

function pick<T>(items: readonly T[], v: number, salt = 0): T {
  return items[Math.floor(((v * 7919 + salt * 0.618) % 1) * items.length)];
}

/** Gable roof with the ridge along x (or z), base at y. */
function gable(
  w: number,
  h: number,
  d: number,
  color: number,
  x: number,
  y: number,
  z: number,
  alongZ = false,
) {
  const m = new Mesh(gableGeo, mat(color));
  m.scale.set(w, h, d);
  if (alongZ) {
    m.rotation.y = Math.PI / 2;
    m.scale.set(d, h, w);
  }
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function cone(
  r: number,
  h: number,
  color: number,
  x: number,
  y: number,
  z: number,
  geo = spireGeo,
) {
  const m = new Mesh(geo, mat(color));
  m.scale.set(r, h, r);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** Windows across the front (z = `z`), `n` of them, on one floor. */
function windows(g: Group, n: number, w: number, y: number, z: number, glass = C.window) {
  for (let k = 0; k < n; k++) {
    const x = 0.5 + (k - (n - 1) / 2) * (w / n);
    g.add(box(0.07, 0.07, 0.012, glass, x, y, z));
  }
}

function tree(g: Group, x: number, y: number, z: number, s: number, v: number) {
  g.add(cyl(0.025 * s, 0.1 * s, C.trunk, x, y, z));
  g.add(cone(0.12 * s, 0.3 * s, pick(C.leaves, v, x + z), x, y + 0.08 * s, z, treeGeo));
}

function cottage(g: Group, y: number, v: number) {
  const wall = pick(WALLS, v);
  g.add(box(0.5, 0.22, 0.36, wall, 0.5, y, 0.45));
  g.add(gable(0.58, 0.18, 0.44, pick(ROOFS, v, 1), 0.5, y + 0.22, 0.45));
  g.add(box(0.08, 0.13, 0.012, DOOR, 0.36, y, 0.635));
  windows(g, 1, 0.2, y + 0.08, 0.635);
  g.add(box(0.06, 0.12, 0.06, BRICK[0], 0.66, y + 0.28, 0.4));
  // A net drying on poles, or a dinghy turned over in the garden.
  if (v < 0.5) {
    g.add(cyl(0.012, 0.16, C.woodDark, 0.12, y, 0.2));
    g.add(cyl(0.012, 0.16, C.woodDark, 0.12, y, 0.75));
    g.add(box(0.01, 0.1, 0.5, 0x6d7f74, 0.12, y + 0.05, 0.47));
  } else {
    g.add(box(0.14, 0.05, 0.3, pick(C.hulls, v, 2), 0.88, y, 0.42));
  }
}

function house(g: Group, y: number, v: number) {
  const wall = pick(WALLS, v);
  g.add(box(0.6, 0.38, 0.46, wall, 0.5, y, 0.45));
  g.add(gable(0.68, 0.2, 0.54, pick(ROOFS, v, 1), 0.5, y + 0.38, 0.45));
  g.add(box(0.09, 0.15, 0.012, DOOR, 0.5, y, 0.685));
  windows(g, 2, 0.4, y + 0.06, 0.685);
  windows(g, 3, 0.48, y + 0.24, 0.685);
  g.add(box(0.07, 0.14, 0.07, BRICK[1], 0.28, y + 0.42, 0.38));
  // Front garden hedge.
  g.add(box(0.3, 0.06, 0.06, C.leaves[0], 0.24, y, 0.9));
  g.add(box(0.3, 0.06, 0.06, C.leaves[0], 0.76, y, 0.9));
}

function shop(g: Group, y: number, v: number) {
  const wall = pick(BRICK, v);
  const floors = v < 0.5 ? 2 : 3;
  const h = 0.2 + floors * 0.17;
  g.add(box(0.84, h, 0.66, wall, 0.5, y, 0.45));
  // Shopfront with an awning, and flats above.
  g.add(box(0.7, 0.13, 0.012, pick(GLASS, v), 0.5, y + 0.02, 0.785));
  const awning = box(0.76, 0.02, 0.14, pick(AWNINGS, v, 3), 0.5, y + 0.17, 0.83);
  awning.rotation.x = 0.35;
  g.add(awning);
  for (let f = 0; f < floors; f++) {
    const fy = y + 0.26 + f * 0.17;
    windows(g, 4, 0.72, fy, 0.785);
    windows(g, 4, 0.72, fy, 0.115);
    if (f === 0) windows(g, 4, 0.72, y + 0.05, 0.115);
  }
  g.add(box(0.88, 0.04, 0.7, C.concrete, 0.5, y + h, 0.45));
  g.add(box(0.5, 0.05, 0.012, C.cabin, 0.5, y + h - 0.08, 0.786));
}

function flats(g: Group, y: number, v: number) {
  const floors = 5 + Math.floor(v * 3);
  const h = 0.1 + floors * 0.16;
  const wall = pick([0xe6e1d6, 0xd8d2c4, 0xc9cfd4, 0xe8d9c4], v);
  g.add(box(0.78, h, 0.7, wall, 0.5, y, 0.5));
  // A band of windows round every floor, and balconies on the front.
  for (let f = 0; f < floors; f++) {
    const fy = y + 0.12 + f * 0.16;
    g.add(box(0.79, 0.06, 0.71, pick(GLASS, v), 0.5, fy, 0.5));
    if (f > 0) g.add(box(0.5, 0.025, 0.06, C.concrete, 0.5, fy - 0.03, 0.87));
  }
  g.add(box(0.2, 0.1, 0.012, DOOR, 0.5, y, 0.855));
  g.add(box(0.82, 0.03, 0.74, C.quayWall, 0.5, y + h, 0.5));
  g.add(box(0.2, 0.1, 0.2, C.chassis, 0.32, y + h + 0.03, 0.4));
}

function tower(g: Group, y: number, v: number) {
  const floors = 12 + Math.floor(v * 8);
  const h = floors * 0.16;
  const glass = pick(GLASS, v);
  g.add(box(0.7, h, 0.7, glass, 0.5, y, 0.5));
  // Concrete floor plates every other storey and a crown on top.
  for (let f = 2; f < floors; f += 2)
    g.add(box(0.72, 0.03, 0.72, C.concrete, 0.5, y + f * 0.16, 0.5));
  for (const [x, z] of [
    [0.15, 0.15],
    [0.85, 0.15],
    [0.15, 0.85],
    [0.85, 0.85],
  ]) {
    g.add(box(0.06, h + 0.04, 0.06, C.concrete, x, y, z));
  }
  g.add(box(0.86, 0.12, 0.86, C.concrete, 0.5, y, 0.5));
  g.add(box(0.5, 0.14, 0.5, C.quayWall, 0.5, y + h, 0.5));
  if (v > 0.4) g.add(cyl(0.012, 0.4, C.chassis, 0.5, y + h + 0.14, 0.5));
}

function chapel(g: Group, y: number) {
  g.add(box(0.38, 0.3, 0.56, 0xf6f3ec, 0.5, y, 0.42));
  g.add(gable(0.46, 0.22, 0.64, 0x5d6670, 0.5, y + 0.3, 0.42, true));
  // Bell tower and spire at the front, onto the square.
  g.add(box(0.2, 0.46, 0.2, 0xf6f3ec, 0.5, y, 0.76));
  g.add(cone(0.15, 0.36, 0x5d6670, 0.5, y + 0.46, 0.76));
  g.add(box(0.08, 0.12, 0.012, DOOR, 0.5, y, 0.865));
  g.add(box(0.012, 0.1, 0.06, 0x7a8ea6, 0.305, y + 0.12, 0.3));
  g.add(box(0.012, 0.1, 0.06, 0x7a8ea6, 0.695, y + 0.12, 0.3));
}

function fishShed(g: Group, y: number, v: number) {
  g.add(box(0.46, 0.22, 0.34, C.woodDark, 0.5, y, 0.32));
  g.add(gable(0.52, 0.12, 0.4, 0x5d6670, 0.5, y + 0.22, 0.32));
  g.add(box(0.16, 0.16, 0.012, C.wood, 0.5, y, 0.495));
  g.add(cyl(0.05, 0.09, C.wood, 0.2, y, 0.6, 8));
  g.add(cyl(0.05, 0.09, C.wood, 0.3, y, 0.66, 8));
  // A rowing boat drawn up on the beach, bow to the sea.
  const hull = pick(C.hulls, v);
  g.add(box(0.16, 0.06, 0.34, hull, 0.74, y, 0.72));
  g.add(box(0.12, 0.012, 0.26, C.wood, 0.74, y + 0.06, 0.72));
  const bow = box(0.11, 0.06, 0.11, hull, 0.74, y, 0.89);
  bow.rotation.y = Math.PI / 4;
  g.add(bow);
}

function park(g: Group, y: number, v: number) {
  g.add(box(0.96, 0.02, 0.96, C.verge, 0.5, y, 0.5));
  g.add(box(0.96, 0.025, 0.14, C.flagstone, 0.5, y, 0.5));
  g.add(box(0.14, 0.025, 0.96, C.flagstone, 0.5, y, 0.5));
  // A fountain or a bandstand where the paths meet, trees in the corners.
  if (v < 0.5) {
    g.add(cyl(0.16, 0.05, C.concrete, 0.5, y, 0.5, 12));
    g.add(cyl(0.12, 0.052, C.waterShallow, 0.5, y, 0.5, 12));
    g.add(cyl(0.025, 0.14, C.concrete, 0.5, y, 0.5, 6));
  } else {
    g.add(cyl(0.17, 0.04, C.cabin, 0.5, y, 0.5, 8));
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      g.add(cyl(0.01, 0.18, C.cabin, 0.5 + Math.cos(a) * 0.13, y + 0.04, 0.5 + Math.sin(a) * 0.13));
    }
    g.add(cone(0.2, 0.1, C.funnel, 0.5, y + 0.22, 0.5, canopyGeo));
  }
  for (const [x, z] of [
    [0.2, 0.2],
    [0.8, 0.2],
    [0.2, 0.8],
    [0.8, 0.8],
  ]) {
    tree(g, x, y, z, 1 + ((v * 13 + x + z) % 0.4), v);
  }
}

/**
 * Merge a model's parts into one mesh per colour. A city is thousands of
 * little boxes; drawn one by one they would bring the frame rate down.
 */
export function bake(g: Group): Group {
  g.updateMatrixWorld(true);
  const parts = new Map<Material, BufferGeometry[]>();
  g.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const geo = (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld);
    const flat = geo.index ? geo.toNonIndexed() : geo;
    const m = o.material as Material;
    parts.set(m, [...(parts.get(m) ?? []), flat]);
  });
  const out = new Group();
  for (const [m, geos] of parts) {
    const merged = mergeGeometries(geos);
    if (!merged) continue;
    const mesh = new Mesh(merged, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.add(mesh);
  }
  return out;
}

/** A town building, facing +z; null for codes that are not one. */
export function townBuilding(code: number, top: number, v: number): Group | null {
  const g = new Group();
  switch (code) {
    case Build.Cottage:
      cottage(g, top, v);
      break;
    case Build.House:
      house(g, top, v);
      break;
    case Build.Shop:
      shop(g, top, v);
      break;
    case Build.Flats:
      flats(g, top, v);
      break;
    case Build.Tower:
      tower(g, top, v);
      break;
    case Build.Chapel:
      chapel(g, top);
      break;
    case Build.FishShed:
      fishShed(g, top, v);
      break;
    case Build.Park:
      park(g, top, v);
      break;
    default:
      return null;
  }
  return bake(g);
}

/**
 * Pavements down the sides of a town street with no street beyond, and now
 * and then a street lamp. `open` holds which sides (+x, -x, +z, -z) carry on.
 */
export function pavements(
  g: Group,
  top: number,
  open: readonly boolean[],
  lamp: boolean,
): Object3D {
  const y = top + 0.05;
  const sides = [
    [0.93, 0.5, 0.14, 1],
    [0.07, 0.5, 0.14, 1],
    [0.5, 0.93, 1, 0.14],
    [0.5, 0.07, 1, 0.14],
  ] as const;
  sides.forEach(([x, z, w, d], k) => {
    if (open[k]) return;
    g.add(box(w, 0.025, d, PAVING, x, y, z));
    // Kerb on the road side.
    const kx = w < 1 ? (x > 0.5 ? x - 0.07 : x + 0.07) : x;
    const kz = d < 1 ? (z > 0.5 ? z - 0.07 : z + 0.07) : z;
    g.add(box(w < 1 ? 0.02 : 1, 0.03, d < 1 ? 0.02 : 1, KERB, kx, y, kz));
  });
  if (lamp) {
    const side = sides.findIndex((_, k) => !open[k]);
    if (side >= 0) {
      const [x, z] = sides[side];
      g.add(cyl(0.012, 0.36, C.chassis, x, y, z));
      g.add(box(0.06, 0.03, 0.06, 0xfff2b0, x, y + 0.36, z));
    }
  }
  return g;
}
